"""Deploy pool-dashboard to the Orange Pi via SFTP."""
import os
import paramiko

HOST, USER, PASS = "192.168.1.221", "orangepi", "orangepi"
SRC = r"C:\AI Stuff\Claude\ScrewPentair\pool-dashboard"
DST = "/home/orangepi/pool-dashboard"

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASS, timeout=20)
sftp = c.open_sftp()

def ensure_dir(p):
    try: sftp.stat(p)
    except FileNotFoundError: sftp.mkdir(p)

ensure_dir(DST)
ensure_dir(DST + "/public")

count = 0
for root, dirs, files in os.walk(SRC):
    dirs[:] = [d for d in dirs if d != "node_modules"]
    rel = os.path.relpath(root, SRC).replace("\\", "/")
    rdst = DST if rel == "." else DST + "/" + rel
    ensure_dir(rdst)
    for f in files:
        if f in ("data.sqlite", "dashconfig.json"):
            continue  # never clobber runtime data on redeploy
        local = os.path.join(root, f)
        sftp.put(local, rdst + "/" + f)
        count += 1
        print("up:", rdst + "/" + f)

sftp.close()
c.close()
print(f"UPLOADED {count} files")
