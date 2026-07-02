    # CRM "Won't Open" — DNS Resolution Diagnosis

    ## 1. Details about what is the issue?

    A teammate could not open the CRM. On his **MacBook**, he typed `crm.itarang.com` into Chrome and
    landed on the **Google homepage** instead of the CRM. On other machines the same URL opens fine.

    What is actually happening:

    - He typed the **bare hostname** (no `https://`), so his computer asked its DNS resolver for the
      IP of `crm.itarang.com` and got **no usable answer** back.
    - When Chrome can't resolve a typed hostname, the address bar treats the text as a **search** and
      sends it to Google. That's why he saw the Google homepage, not a "site can't be reached" error —
      the CRM never loaded.

    **Scope:** This is **not** a bug in the CRM, server, SSL certificate, or domain config. The server
    is healthy and DNS is correct worldwide — the failure was **local to his machine's DNS lookup**.
    We still investigated deeply because, if the fault were on our side, a **customer** could hit the
    same screen.

    ---

    ## 2. How will you approach to diagnose this problem / how to solve it?

    The request passes through several layers before the CRM loads:

    ```
    User's browser
      -> User's DNS resolver (Mac cache -> router -> ISP / office DNS)
        -> Authoritative DNS (ns1/ns2.dns-parking.com at Hostinger)   [name -> IP]
      -> Network connection to the IP
        -> nginx on the VPS (72.61.246.37)  [TLS + routing]  -> CRM app -> /login
    ```

    The "Google homepage" symptom can come from any layer, so the approach is to **test each layer
    from the outside in** and find where it breaks:

    1. **Is the server alive?** Reach it over HTTPS and by raw IP; check the TLS cert. (Rules out:
      server down, bad cert, wrong server.)
    2. **Does the name map to the right IP at the source?** Query **both** authoritative nameservers
      directly. (Rules out: missing/wrong record, nameservers disagreeing.)
    3. **Do public resolvers agree?** Google, Cloudflare, Quad9, OpenDNS. (Rules out: propagation gaps.)
    4. **Are the record types clean?** A, AAAA (IPv6), CNAME. (Rules out: a broken IPv6 record that
      only Macs, which prefer IPv6, would trip over.)
    5. **Wildcard / parking probe** — resolve a made-up subdomain to see what a *missing* record does.
    6. **Check TTLs** — how long a stale answer can stay cached.
    7. **Corroborate on the VPS** — read-only SSH to verify nginx config and cert.

    If every layer we control is correct, the only one left to fail is the **user's own
    resolver/cache** — and the fix is to clear/replace it and always open the full `https://` URL.

    ---

    ## 3. How you find this diagnosis? (evidence)

    All commands are **read-only**; results captured 2026-06-30.

    ### A. The server is healthy

    - `curl -I https://crm.itarang.com` → **`307 Temporary Redirect → /login`** (normal — an
      unauthenticated visitor is sent to login).
    - TLS cert: **Let's Encrypt**, `CN=crm.itarang.com`, valid **Apr 14 → Jul 13 2026**. No cert error.
    - Reaching the server by raw IP also returns `307` — it answers correctly regardless of DNS.

    ### B. VPS confirmation (read-only SSH)

    - `srv1233189`, Ubuntu 24.04. nginx vhost `crm.itarang.com.conf` has `server_name crm.itarang.com`,
      the matching cert, and listens on **both IPv4 and IPv6**. Since DNS publishes no AAAA, clients
      only ever connect over IPv4 — consistent, no conflict.

    **A + B: server, routing, and certificate are all correct.**

    ### C. DNS is correct and globally consistent

    - `crm.itarang.com` **A record = `72.61.246.37`**, returned **identically** by both authoritative
      nameservers (`ns1`/`ns2.dns-parking.com`) and by Google, Cloudflare, Quad9, and OpenDNS. No
      disagreement, no propagation gap.
    - **No AAAA, no CNAME** — so no broken IPv6 record for a Mac to trip on. (The `64:ff9b::…` address
      seen earlier was just **NAT64** synthesizing IPv6 from the IPv4 record, not a real record.)
    - **Wildcard probe:** `randomxyz123abc.itarang.com` → **NXDOMAIN**. There's no catch-all — so if a
      resolver lacks the `crm` record, it returns "this name doesn't exist," and Chrome routes the text
      to Google. **This is the exact mechanism behind the symptom.**
    - TTLs: ~57 min positive, ~10 min negative — a stale cache is possible but **self-heals** quickly.

    ### D. The deciding logic

    Every layer we control is correct: server, cert, both authoritative nameservers, all public
    resolvers, no wildcard surprise. The only one left to fail is the **user's own DNS path** (Mac
    cache + router/ISP/office resolver).

    This is confirmed by the fix: `nslookup crm.itarang.com 8.8.8.8` returned the right IP, and
    flushing his DNS cache made the lookup work. **Bypassing his local resolver fixed it — proving the
    fault was there, not in our DNS or server.** Most likely trigger: a **stale negative answer**
    cached from before the recent zone update, or a momentarily unreliable ISP/router DNS. Either way,
    client-side and transient.

    ---

    ## 4. Fix / solution of this problem

    ### A. Immediate fix for any user hitting this (macOS)

    1. Flush the DNS cache in **Terminal**:
      ```bash
      sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
      ```
    2. Open the CRM with the **full `https://` URL** (stops Chrome from "searching" on a hiccup):
      `https://crm.itarang.com`
    3. If it still fails, switch DNS to a reliable resolver: **System Settings → Network → (Wi-Fi) →
      Details → DNS → +** `8.8.8.8` and `8.8.4.4`, **Apply**, then flush again.
      *(Windows equivalent of step 1: `ipconfig /flushdns`.)*

    ### B. Make this safe for customers (prevention)

    - **Always share a clickable `https://crm.itarang.com` link** — never the bare hostname. A full URL
      forces the browser to navigate, so a DNS hiccup shows a clear error instead of dumping the user on
      Google. **This single habit eliminates the exact symptom.**
    - **Keep the `crm` A record permanent** — never delete-and-recreate it; even a brief gap lets
      resolvers cache an NXDOMAIN and reopens this window.
    - **Add lightweight monitoring** — an uptime/DNS check on `https://crm.itarang.com` (and cert
      expiry, good until Jul 13 2026) so issues are caught before customers report them.

    ### C. Server / infrastructure changes required

    **None.** The VPS, nginx vhost, routing, and certificate are all correct, and DNS is globally
    consistent. The root cause was a **client-side DNS cache/resolver** — fixed by section A, prevented
    for customers by section B.
