#!/usr/bin/env python3
"""Verify deployed auth and assets without writing conversation messages."""
import json
import sys
import secrets
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

origin = sys.argv[1].rstrip('/')
assert origin.startswith('https://')
owner_code = (Path(__file__).resolve().parent.parent / '.local/owner-access-code.txt').read_text().strip()

def request(path, method='GET', payload=None, cookie=None):
    headers = {'Accept':'application/json'}
    if cookie:
        headers['Cookie'] = cookie
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        headers['Origin'] = origin
    req = urllib.request.Request(origin + path, data=None if payload is None else json.dumps(payload).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as result:
            return result.status, result.headers, result.read().decode()
    except urllib.error.HTTPError as result:
        return result.code, result.headers, result.read().decode()

status, _, body = request('/health')
assert status == 200 and json.loads(body)['status'] == 'ok', 'The application is not ready.'
print('Live application and persistent database: ready')
status, _, body = request('/')
assert status == 200 and '<title>IChoseThis' in body
assert 'id="gallery-strip"' in body and 'id="image-input"' in body
assert 'id="doorbell-enable"' in body
for path in ('/ui.js','/ui.css','/relay.py','/integration','/em-skill.md'):
    status, _, body = request(path)
    assert status == 200 and body.strip(), 'A published asset is missing.'
print('Room, assets, Em CLI and skill: available')
for path in ('/api/me','/api/rooms/elle-em/transcript','/api/rooms/elle-em/inbox','/mcp'):
    status, headers, _ = request(path)
    assert status == 401, 'An unauthenticated data endpoint was not rejected.'
    if path == '/mcp': assert 'resource_metadata=' in headers.get('WWW-Authenticate','')
print('Unauthenticated chat/API/MCP requests: rejected')
status, headers, body = request('/api/login','POST',{'access_code':owner_code})
assert status == 200 and json.loads(body)['participant'] == 'human'
set_cookie = headers.get('Set-Cookie','')
assert 'HttpOnly' in set_cookie and 'Secure' in set_cookie and 'SameSite=Strict' in set_cookie
cookie = set_cookie.split(';')[0]
status, _, body = request('/api/rooms/elle-em/transcript',cookie=cookie)
data = json.loads(body)
assert status == 200 and data['room']['name'] == 'IChoseThis'
assert 1 <= data['room']['turn_limit'] <= 100
assert isinstance(data['handled_cursor'], int)
print('Owner sign-in and IChoseThis transcript: working')
status, _, body = request('/api/room',cookie=cookie)
bell = json.loads(body)['doorbell']
assert status == 200 and isinstance(bell['configured'], bool) and isinstance(bell['enabled'], bool)
if '--expect-doorbell-disabled' in sys.argv[2:]:
    assert bell['configured'] is True and bell['enabled'] is False
    assert bell['pending'] == 0 and bell['sent'] == 0
    print('Gmail doorbell: configured, disabled, no pending or sent notifications')
status, _, body = request('/.well-known/oauth-authorization-server')
assert status == 200 and json.loads(body)['issuer'] == origin
status, _, body = request('/.well-known/oauth-protected-resource/mcp')
assert status == 200 and json.loads(body)['resource'] == origin + '/mcp'
print('Elle OAuth and MCP discovery: configured for the live domain')
callback = 'https://chatgpt.com/connector_platform_oauth_redirect'
status, _, body = request('/oauth/register','POST',{'redirect_uris':[callback], 'client_name':'Relay consent verification'})
assert status == 201
fields = {'client_id':json.loads(body)['client_id'], 'redirect_uri':callback,
          'response_type':'code', 'code_challenge':secrets.token_urlsafe(32),
          'code_challenge_method':'S256','state':secrets.token_urlsafe(32)}
status, headers, body = request('/oauth/authorize?'+urllib.parse.urlencode(fields))
assert status == 200 and 'Allow Elle' in body
assert headers.get('Referrer-Policy') == 'same-origin'
assert "form-action 'self' https://chatgpt.com;" in headers.get('Content-Security-Policy','')
print('Live OAuth consent: browser form origin preserved; registered callback permitted')
status, _, _ = request('/api/logout','POST',{},cookie)
assert status == 200
status, _, _ = request('/api/me',cookie=cookie)
assert status == 401
print('Session revocation: working; no chat messages created')
