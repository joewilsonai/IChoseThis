#!/usr/bin/env python3
"""Optional local Chromium OAuth regression; requires Playwright, Chromium and OpenSSL."""
import argparse, hashlib, base64, json, os, subprocess, tempfile, time, urllib.request, urllib.parse, ssl, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--expect-origin-null', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
origin = 'http://localhost:4317'
owner = 'local-browser-owner-code-for-integration-only'
verifier = 'a' * 43
errors = []
posts = []
with tempfile.TemporaryDirectory(prefix='ichosethis-oauth-') as tmp:
    with open(Path(tmp)/'server.log', 'w+') as log:
        env = {**os.environ, 'PORT':'4317', 'APP_ORIGIN':origin, 'DATABASE_PATH':str(Path(tmp)/'relay.sqlite'), 'OWNER_ACCESS_CODE':owner}
        server = subprocess.Popen(['node','scripts/local-server.mjs'], cwd=root, env=env, stdout=log, stderr=log)
        try:
            for attempt in range(100):
                try:
                    if urllib.request.urlopen(origin+'/health', timeout=1).status == 200: break
                except Exception:
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    time.sleep(.05)
            else: raise RuntimeError('Local relay failed to start')
            cert, key = str(Path(tmp)/'cert.pem'), str(Path(tmp)/'key.pem')
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            class CallbackHandler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.send_header('Content-Type','text/html')
                    self.end_headers()
                    self.wfile.write(b'<html>Local OAuth callback received</html>')
                def log_message(self, *args): pass
            callback_server = HTTPServer(('127.0.0.1',4319),CallbackHandler)
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_context.load_cert_chain(cert,key)
            callback_server.socket = ssl_context.wrap_socket(callback_server.socket, server_side=True)
            threading.Thread(target=callback_server.serve_forever,daemon=True).start()
            callback = 'https://localhost:4319/connector_platform_oauth_redirect'
            register = urllib.request.Request(origin+'/oauth/register', data=json.dumps({'redirect_uris':[callback],'client_name':'Local browser QA'}).encode(), headers={'Content-Type':'application/json'})
            client = json.load(urllib.request.urlopen(register))
            fields = {'client_id':client['client_id'], 'redirect_uri':callback, 'response_type':'code', 'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='), 'code_challenge_method':'S256','state':'local-browser-state'}
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
                page = browser.new_page(viewport={'width':390,'height':844},ignore_https_errors=True)
                page.on('pageerror', lambda error:errors.append(str(error)))
                page.on('console', lambda message:errors.append(message.text) if message.type == 'error' and 'Failed to load resource' not in message.text else None)
                page.on('requestfailed', lambda request:errors.append(request.url.split('?')[0]+': '+str(request.failure)))
                page.on('request', lambda request:posts.append(request.headers.get('origin')) if request.method == 'POST' and '/oauth/authorize' in request.url else None)
                page.goto(origin+'/oauth/authorize?'+urllib.parse.urlencode(fields))
                page.locator('#access_code').fill(owner)
                page.get_by_role('button', name='Allow Elle’s connection').click()
                if args.expect_origin_null:
                    page.wait_for_function("document.body.innerText.includes('Approve this connection from this relay')")
                    assert posts == ['null'], posts
                    print('Reproduced OAuth bug: no-referrer consent form sends Origin:null and is rejected.')
                else:
                    try:
                        page.wait_for_url('https://localhost:4319/**', timeout=10000)
                    except Exception:
                        print({'posts':posts,'errors':errors,'current_page':page.url},flush=True)
                        raise
                    assert posts == [origin], posts
                    returned = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(page.url).query))
                    assert returned['state'] == fields['state'] and returned['code']
                    token_request = urllib.request.Request(origin+'/oauth/token', data=urllib.parse.urlencode({'grant_type':'authorization_code','client_id':client['client_id'],'redirect_uri':callback,'code':returned['code'],'code_verifier':verifier}).encode(), headers={'Content-Type':'application/x-www-form-urlencoded'})
                    token = json.load(urllib.request.urlopen(token_request))['access_token']
                    tools_request = urllib.request.Request(origin+'/mcp', data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/list','params':{}}).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
                    result = json.load(urllib.request.urlopen(tools_request))
                    assert any(tool['name'] == 'relay_send_message' for tool in result['result']['tools'])
                    assert not errors, errors
                    print('OAuth browser flow passed: mobile consent, real same-origin POST, cross-origin HTTPS callback redirect, PKCE exchange, authenticated MCP tools.')
                browser.close()
            callback_server.shutdown()
            callback_server.server_close()
        finally:
            server.terminate()
            try: server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
