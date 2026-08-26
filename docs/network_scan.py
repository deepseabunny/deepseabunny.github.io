#!/usr/bin/env python3
"""
Fast LAN scanner with rich terminal output.
Prints a colored table: hostname | ip | open ports
Requires: pip install rich
Optional (better mDNS): pip install zeroconf
"""

import socket
import subprocess
import ipaddress
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Tuple, Dict, Optional
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn

# Optional mDNS (improves .local names)
try:
    from zeroconf import Zeroconf, ServiceBrowser
    ZEROCONF_AVAILABLE = True
except Exception:
    ZEROCONF_AVAILABLE = False

console = Console()
SUBNET = "192.168.1.0/24"
PORTS = [22, 80, 443, 8080]          # keep small for speed; configurable
SOCKET_TIMEOUT = 0.18
MAX_WORKERS = 200

# --- discovery helpers -----------------------------------------------------
def arp_cache_ips() -> List[str]:
    """Parse local ARP cache for IPs (fast, no root)."""
    try:
        out = subprocess.check_output(["arp", "-a"], stderr=subprocess.DEVNULL, timeout=2)
        ips = set()
        for token in out.decode(errors="ignore").replace("(", " ").replace(")", " ").split():
            if token.count(".") == 3:
                parts = token.split(".")
                if all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
                    ips.add(token)
        return sorted(ips)
    except Exception:
        return []

def quick_ping_sweep(subnet: str) -> List[str]:
    """Fallback ping sweep (parallel)."""
    net = ipaddress.ip_network(subnet, strict=False)
    hosts = [str(ip) for ip in net.hosts()]
    alive = []

    def ping(ip: str) -> bool:
        try:
            p = subprocess.run(["ping", "-c", "1", "-W", "1", ip],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1.5)
            return p.returncode == 0
        except Exception:
            return False

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(ping, ip): ip for ip in hosts}
        for fut in as_completed(futures):
            ip = futures[fut]
            try:
                if fut.result():
                    alive.append(ip)
            except Exception:
                pass
    return alive

def mdns_map(timeout: float = 1.5) -> Dict[str, str]:
    """Collect mDNS names (optional)."""
    if not ZEROCONF_AVAILABLE:
        return {}
    zer = Zeroconf()
    ip_to_name: Dict[str, str] = {}
    class L:
        def remove_service(self, *a, **k): pass
        def add_service(self, zeroconf, type, name):
            try:
                info = zeroconf.get_service_info(type, name)
                if info and info.addresses:
                    for addr in info.addresses:
                        ip = socket.inet_ntoa(addr)
                        ip_to_name[ip] = name.rstrip(".")
            except Exception:
                pass
    types = ["_workstation._tcp.local.", "_http._tcp.local.", "_ssh._tcp.local."]
    try:
        browsers = [ServiceBrowser(zer, t, L()) for t in types]
        import time; time.sleep(timeout)
        return ip_to_name
    finally:
        zer.close()

def discover_hosts(subnet: str) -> List[str]:
    # 1) ARP cache
    ips = arp_cache_ips()
    if ips:
        return ips
    # 2) fallback ping sweep
    return quick_ping_sweep(subnet)

# --- scanning and resolution ----------------------------------------------
def scan_ports(ip: str, ports: List[int]=PORTS, timeout: float=SOCKET_TIMEOUT) -> List[int]:
    open_ports: List[int] = []
    for port in ports:
        try:
            conn = socket.create_connection((ip, port), timeout=timeout)
            conn.close()
            open_ports.append(port)
        except Exception:
            pass
    return open_ports

def resolve_name(ip: str, mdns_cache: Dict[str, str]) -> str:
    # try getfqdn, then mdns cache, then fallback to ip
    try:
        fqdn = socket.getfqdn(ip)
        if fqdn and fqdn != ip:
            return fqdn
    except Exception:
        pass
    if ip in mdns_cache:
        return mdns_cache[ip]
    return ip

# --- main -----------------------------------------------------------------
def main():
    console.rule("[bold green]LAN Scan")
    console.log("Discovering hosts...")
    hosts = discover_hosts(SUBNET)
    if not hosts:
        console.print("[yellow]No hosts discovered. Try running the script with sudo or install scapy for ARP arping.")
        return

    mdns_cache = mdns_map() if ZEROCONF_AVAILABLE else {}

    results: List[Tuple[str, str, List[int]]] = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Scanning hosts...", total=len(hosts))
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            future_to_ip = {ex.submit(scan_ports, ip): ip for ip in hosts}
            for fut in as_completed(future_to_ip):
                ip = future_to_ip[fut]
                try:
                    ports = fut.result()
                except Exception:
                    ports = []
                hostname = resolve_name(ip, mdns_cache)
                results.append((hostname, ip, ports))
                progress.advance(task)

    # build and print table
    table = Table(show_header=True, header_style="bold magenta")
    table.add_column("Hostname", style="cyan", no_wrap=True)
    table.add_column("IP", style="green")
    table.add_column("Open Ports", style="yellow", justify="right")

    for hostname, ip, ports in sorted(results, key=lambda x: x[0].lower()):
        ports_str = ",".join(map(str, ports)) if ports else "-"
        table.add_row(hostname, ip, ports_str)

    console.print(table)
    console.print(f"[bold]{len(results)}[/bold] hosts found.")

if __name__ == "__main__":
    main()
