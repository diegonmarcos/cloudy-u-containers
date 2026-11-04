"""LinkedIn — official data-export parser (zero account risk).

LinkedIn live scraping violates ToS and is heavily bot-blocked, so scrape() is disabled;
the supported path is uploading the official "Get a copy of your data" zip to
/scrappers/scrape/linkedin/export, which parse_export() turns into the profile JSON.
Mirrors front/b-Media/mySocials extract_li_export.py so both stay in sync.
"""
import csv
import io
import zipfile


def scrape(**_):
    raise RuntimeError(
        "LinkedIn live scraping is disabled (ToS + bot-block). "
        "POST the official data-export zip to /scrappers/scrape/linkedin/export instead."
    )


def _rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as fh:
        lines = io.TextIOWrapper(fh, encoding="utf-8").readlines()
    start = 0
    if lines and lines[0].startswith("Notes:"):
        start = next(i for i, ln in enumerate(lines) if not ln.strip()) + 1
    yield from csv.DictReader(lines[start:])


def _dates(start, end):
    start, end = (start or "").strip(), (end or "").strip()
    if not start:
        return end
    return f"{start} - {end}" if end else f"{start} - Present"


def parse_export(raw: bytes) -> dict:
    zf = zipfile.ZipFile(io.BytesIO(raw))
    names = {n.split("/")[-1]: n for n in zf.namelist()}

    def rows(fname):
        return _rows(zf, names[fname]) if fname in names else iter(())

    p = next(rows("Profile.csv"), {})
    last = (p.get("Last Name", "")).split(" - (")[0].strip()
    conn = sum(1 for _ in rows("Connections.csv"))

    data = {
        "profile": {
            "name": f"{p.get('First Name','').strip()} {last}".strip(),
            "headline": p.get("Headline", "").strip().strip("|").strip(),
            "location": p.get("Geo Location", "").strip(),
            "connections": "500+" if conn >= 500 else str(conn),
        },
        "about": p.get("Summary", "").strip(),
        "experience": [
            {"title": r["Title"].strip(), "company": r["Company Name"].strip(),
             "dates": _dates(r.get("Started On"), r.get("Finished On")), "location": r.get("Location", "").strip()}
            for r in rows("Positions.csv")
        ],
        "education": [
            {"school": r["School Name"].strip(), "degree": r.get("Degree Name", "").strip(),
             "dates": _dates(r.get("Start Date"), r.get("End Date"))}
            for r in rows("Education.csv")
        ],
        "skills": [r["Name"].strip() for r in rows("Skills.csv") if r.get("Name", "").strip()],
        "languages": [
            {"name": r["Name"].strip(), "proficiency": r.get("Proficiency", "").strip()}
            for r in rows("Languages.csv") if r.get("Name", "").strip()
        ],
        "projects": [
            {"title": r["Title"].strip(), "description": r.get("Description", "").strip(),
             "url": r.get("Url", "").strip(), "dates": _dates(r.get("Started On"), r.get("Finished On"))}
            for r in rows("Projects.csv") if r.get("Title", "").strip()
        ],
    }
    data["_summary"] = {
        "experience": len(data["experience"]), "education": len(data["education"]),
        "skills": len(data["skills"]), "languages": len(data["languages"]), "projects": len(data["projects"]),
    }
    return data
