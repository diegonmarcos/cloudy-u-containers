#!/usr/bin/env python3
"""git-drive-backup.py (#1920): upload one repo to the owner's Google Drive.
Runs INSIDE the google-workspace-mcp image on oci-apps (google libs there; the service
account key is bind-mounted read-only, never printed, never leaves the VM).
  git-drive-backup.py repo <name> <zip> <treedir> <sha> <manifest_out>
  git-drive-backup.py manifest <dir_with_json_fragments>
Replace semantics: zip is updated in place by name; the tree is synced (changed files
re-uploaded by md5, new files created, files/folders absent from the repo deleted)."""
import hashlib, json, os, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

KEY = os.environ.get("GDRIVE_KEY_FILE", "/run/secrets/GOOGLE_SERVICE_ACCOUNT_KEY")
SUBJECT = os.environ.get("GDRIVE_SUBJECT", "me@diegonmarcos.com")
ROOT, ZIPS, TREE = "B10_Backup", "E0_Git_zips", "E0_Git"
FOLDER = "application/vnd.google-apps.folder"
tl = threading.local()


def svc():
    if not hasattr(tl, "s"):
        c = service_account.Credentials.from_service_account_file(
            KEY, scopes=["https://www.googleapis.com/auth/drive"], subject=SUBJECT)
        tl.s = build("drive", "v3", credentials=c, cache_discovery=False)
    return tl.s


def retry(fn, n=6):
    for i in range(n):
        try:
            return fn()
        except Exception as e:  # transient 5xx / rate limit / socket
            if i == n - 1:
                raise
            time.sleep(2 ** i)


def children(pid):
    out, tok = [], None
    while True:
        r = retry(lambda: svc().files().list(
            q="'%s' in parents and trashed=false" % pid, pageSize=1000, pageToken=tok,
            fields="nextPageToken,files(id,name,mimeType,md5Checksum)").execute())
        out += r["files"]
        tok = r.get("nextPageToken")
        if not tok:
            return out


def folder(parent, name):
    q = "name='%s' and mimeType='%s' and trashed=false" % (name.replace("'", "\\'"), FOLDER)
    if parent:
        q += " and '%s' in parents" % parent
    else:
        q += " and 'root' in parents"
    r = retry(lambda: svc().files().list(q=q, fields="files(id)").execute())["files"]
    if r:
        return r[0]["id"]
    body = {"name": name, "mimeType": FOLDER}
    if parent:
        body["parents"] = [parent]
    return retry(lambda: svc().files().create(body=body, fields="id").execute())["id"]


def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def put(path, parent, existing_id=None, name=None):
    media = MediaFileUpload(path, mimetype="application/octet-stream",
                            resumable=os.path.getsize(path) > (5 << 20))
    def go():
        if existing_id:
            return svc().files().update(fileId=existing_id, media_body=media, fields="id").execute()
        return svc().files().create(body={"name": name or os.path.basename(path), "parents": [parent]},
                                    media_body=media, fields="id").execute()
    return retry(go)


def rm(fid):
    retry(lambda: svc().files().delete(fileId=fid).execute())


def sync_dir(local, remote_id, stats, jobs):
    kids = children(remote_id)
    byname = {}
    for k in kids:  # duplicates (Drive allows same name): keep first, delete the rest
        if k["name"] in byname:
            jobs.append(("rm", k["id"], stats))
        else:
            byname[k["name"]] = k
    names = set()
    for e in sorted(os.scandir(local), key=lambda x: x.name):
        if e.is_symlink():
            continue
        names.add(e.name)
        k = byname.get(e.name)
        if e.is_dir():
            if k and k["mimeType"] != FOLDER:
                jobs.append(("rm", k["id"], stats)); k = None
            fid = k["id"] if k else retry(lambda: svc().files().create(
                body={"name": e.name, "mimeType": FOLDER, "parents": [remote_id]}, fields="id").execute())["id"]
            sync_dir(e.path, fid, stats, jobs)
        elif e.is_file():
            if k and k["mimeType"] == FOLDER:
                jobs.append(("rm", k["id"], stats)); k = None
            if k and k.get("md5Checksum") == md5(e.path):
                stats["same"] += 1
            else:
                jobs.append(("put", (e.path, remote_id, k["id"] if k else None, e.name), stats))
    for n, k in byname.items():
        if n not in names:
            jobs.append(("rm", k["id"], stats))


def run_job(j):
    kind, arg, stats = j
    if kind == "rm":
        rm(arg); stats["deleted"] += 1
    else:
        p, parent, fid, name = arg
        put(p, parent, fid, name); stats["uploaded"] += 1


def cmd_repo(name, zpath, tdir, sha, mout):
    root = folder(None, ROOT)
    zid, tid = folder(root, ZIPS), folder(root, TREE)
    zk = [k for k in children(zid) if k["name"] == name + ".zip"]
    put(zpath, zid, zk[0]["id"] if zk else None, name + ".zip")
    for extra in zk[1:]:
        rm(extra["id"])
    rid = folder(tid, name)
    stats = {"same": 0, "uploaded": 0, "deleted": 0}
    jobs = []
    sync_dir(tdir, rid, stats, jobs)
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(run_job, jobs))
    json.dump({"repo": name, "sha": sha, "size": os.path.getsize(zpath),
               "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(mout, "w"))
    print("OK %s zip=%dB tree same=%d uploaded=%d deleted=%d" % (
        name, os.path.getsize(zpath), stats["same"], stats["uploaded"], stats["deleted"]), flush=True)


def cmd_manifest(d, out):
    items = [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".json")]
    json.dump(items, open(out, "w"), indent=1)
    root = folder(None, ROOT)
    zid = folder(root, ZIPS)
    mk = [k for k in children(zid) if k["name"] == "manifest.json"]
    put(out, zid, mk[0]["id"] if mk else None, "manifest.json")
    print("OK manifest.json entries=%d" % len(items))


if __name__ == "__main__":
    if sys.argv[1] == "repo":
        cmd_repo(*sys.argv[2:7])
    elif sys.argv[1] == "manifest":
        cmd_manifest(sys.argv[2], sys.argv[3])
