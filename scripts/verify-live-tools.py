#!/usr/bin/env python3
"""Read the deployed MCP catalog using a temporary OAuth grant, then revoke it."""
import base64
import hashlib
import json
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

origin = sys.argv[1].rstrip('/')
assert origin.startswith('https://')
owner = (Path(__file__).resolve().parent.parent / '.local/owner-access-code.txt').read_text().strip()
callback = 'https://example.invalid/ichosethis-mcp-catalog-verification'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())
def request(path, payload, form=False, token=None):
    headers = {'Content-Type':'application/x-www-form-urlencoded' if form else 'application/json', 'Origin':origin}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    encoded = urllib.parse.urlencode(payload).encode() if form else json.dumps(payload).encode()
    req = urllib.request.Request(origin + path, data=encoded, headers=headers)
    try:
        result = opener.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        return result.status, result.headers, result.read()

grant = None
try:
    status, _, body = request('/oauth/register', {'redirect_uris':[callback], 'client_name':'Temporary MCP catalog verification'})
    assert status == 201, 'Test OAuth registration failed'
    client = json.loads(body)['client_id']
    verifier, state = secrets.token_urlsafe(40), secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    status, headers, _ = request('/oauth/authorize', {
        'client_id':client,'redirect_uri':callback,'response_type':'code',
        'code_challenge':challenge,'code_challenge_method':'S256','state':state,
        'scope':'relay:elle','resource':origin+'/mcp','access_code':owner,'approve':'yes'
    }, form=True)
    assert status == 302, 'Test OAuth consent failed'
    returned_url = urllib.parse.urlparse(headers['Location'])
    assert returned_url.scheme == 'https' and returned_url.netloc == 'example.invalid'
    returned = dict(urllib.parse.parse_qsl(returned_url.query))
    assert returned['state'] == state
    status, _, body = request('/oauth/token', {
        'grant_type':'authorization_code','client_id':client,'redirect_uri':callback,
        'code':returned['code'],'code_verifier':verifier,'resource':origin+'/mcp'
    }, form=True)
    assert status == 200, 'Test OAuth exchange failed'
    grant = json.loads(body)
    status, _, body = request('/mcp', {'jsonrpc':'2.0','id':1,'method':'tools/list','params':{}}, token=grant['access_token'])
    assert status == 200, 'Live MCP catalog request failed'
    catalog = json.loads(body)['result']['tools']
    names = [tool['name'] for tool in catalog]
    assert len(names) == len(set(names)) == 6
    ack = next(tool for tool in catalog if tool['name'] == 'relay_acknowledge')
    assert ack['inputSchema']['required'] == ['through_seq']
    assert ack['inputSchema']['properties']['through_seq']['type'] == 'integer'
    assert ack['annotations']['idempotentHint'] is True
    print('Live authenticated MCP catalog: six tools, including relay_acknowledge {through_seq: integer}.')
    print('Tools: ' + ', '.join(names))
    print('No chat writes, reactions, acknowledgements, or existing credential changes were made.')
finally:
    if grant:
        for kind in ('access_token','refresh_token'):
            if grant.get(kind):
                status, _, _ = request('/oauth/revoke', {'token':grant[kind]}, form=True)
                assert status == 200, 'Temporary test credential cleanup failed'
        print('Temporary verification credentials revoked.')
