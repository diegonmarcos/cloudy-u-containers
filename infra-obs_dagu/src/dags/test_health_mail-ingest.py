#!/usr/bin/env python3
"""Tester: health_mail-ingest's freshness query stays index-only.

2026-11-18 oci-mail: IO PSI ~70, maddy 6GB read in ~4h. This DAG runs every
30 min through `docker exec maddy sqlite3`, i.e. inside maddy's cgroup. Its
old query took MAX(date) over every INBOX row; `date` has no index and
msgs rows carry cachedHeader/bodyStructure inline, so it read every INBOX
row each run. The query now reads only the newest msgIds per INBOX through
the (mboxId, msgId) primary key.

Checks, on go-imap-sql's schema (user-comm_tools-maddy/src/crate/src/db.rs):
  I1 its work does not grow with the number of INBOX rows;
  I2 same answer as the old full-scan query on ordinary data;
  I3 a re-home of old mail into INBOX can only make the age look OLDER
     (false alarm), never younger (missed stall);
  I4 an empty store yields NULL, which the DAG treats as UNKNOWN (alarm).
"""
import re, sqlite3, sys, time, os

DAG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "health_mail-ingest.yaml")
raw = open(DAG).read()
sql = re.search(r'SQL="(.*?)"\n', raw, re.S).group(1)
OLD = ("SELECT CAST((strftime('%s','now') - MAX(m.date))/3600 AS INT) "
       "FROM msgs m JOIN mboxes b ON b.id = m.mboxId WHERE b.name = 'INBOX';")

fails = []
def check(c, label):
    print(("ok:   " if c else "FAIL: ") + label)
    if not c: fails.append(label)

def db():
    c = sqlite3.connect(":memory:")
    c.executescript("""
      CREATE TABLE mboxes(id INTEGER PRIMARY KEY, uid INT, name TEXT, uidnext INT, msgsCount INT, UNIQUE(uid,name));
      CREATE TABLE msgs(mboxId INT, msgId INT, date INT, bodyLen INT, mark INT, bodyStructure BLOB,
                        cachedHeader BLOB, extBodyKey TEXT, seen INT, recent INT, compressAlgo TEXT,
                        PRIMARY KEY(mboxId, msgId));""")
    return c

now = int(time.time())
c = db()
c.executemany("INSERT INTO mboxes(id,uid,name) VALUES(?,?,?)", [(1,1,'INBOX'),(2,1,'Other'),(3,2,'INBOX')])
ins = "INSERT INTO msgs(mboxId,msgId,date,cachedHeader) VALUES(?,?,?,x'00')"
c.executemany(ins, [(1,i,now-86400*30+i*600,) for i in range(1,4000)])
c.executemany(ins, [(2,i,now) for i in range(1,20)])          # newer mail outside INBOX
c.executemany(ins, [(3,i,now-3*3600-i) for i in range(1,80)])

def steps(conn, q):
    n = [0]
    def tick():
        n[0] += 1
        return 0
    conn.set_progress_handler(tick, 1)
    conn.execute(q).fetchone()
    conn.set_progress_handler(None, 1)
    return n[0]

# The old query's plan is ALSO an index SEARCH (mboxId=?) -- it then reads
# every INBOX row for `date`. So measure work: it must not grow with the
# size of INBOX.
big = db()
big.execute("INSERT INTO mboxes(id,uid,name) VALUES(1,1,'INBOX')")
big.executemany(ins, [(1,i,now-i) for i in range(1,4001)])
s_small = steps(big, sql)
big.executemany(ins, [(1,i,now-i) for i in range(4001,40001)])
s_large = steps(big, sql)
check(s_large <= s_small * 1.5,
      "I1 work does not grow with INBOX size (VM steps %d at 4k rows, %d at 40k)" % (s_small, s_large))
new, old = c.execute(sql).fetchone()[0], c.execute(OLD).fetchone()[0]
check(new == old, "I2 same age as the old full-scan query (%s vs %s)" % (new, old))

c.executemany(ins, [(1,10000+i,now-86400*200) for i in range(800)])   # big re-home of old mail
new2, old2 = c.execute(sql).fetchone()[0], c.execute(OLD).fetchone()[0]
check(new2 >= old2, "I3 re-home can only make it look older (%s >= %s)" % (new2, old2))

check(db().execute(sql).fetchone()[0] is None, "I4 empty store -> NULL (DAG alarms UNKNOWN)")

print()
if fails:
    print("FAILED (%d)" % len(fails)); sys.exit(1)
print("PASS")
