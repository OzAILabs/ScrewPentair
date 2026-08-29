"""Run a command on the Orange Pi Zero 2W over SSH and stream output.

Usage: python zssh.py [--user USER] [--timeout SECS] "command"
"""
import sys, argparse
import paramiko

HOST = "192.168.1.221"
PASS = "orangepi"

p = argparse.ArgumentParser()
p.add_argument("--user", default="orangepi")
p.add_argument("--timeout", type=float, default=300)
p.add_argument("command")
args = p.parse_args()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=args.user, password=PASS, timeout=20,
          banner_timeout=30, auth_timeout=30)
stdin, stdout, stderr = c.exec_command(args.command, timeout=args.timeout, get_pty=False)
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
status = stdout.channel.recv_exit_status()
if out:
    print(out, end="" if out.endswith("\n") else "\n")
if err:
    print("[stderr]", err, end="" if err.endswith("\n") else "\n")
print(f"[exit {status}]")
c.close()
sys.exit(status)
