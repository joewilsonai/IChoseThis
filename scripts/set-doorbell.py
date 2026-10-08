#!/usr/bin/env python3
"""Owner-only notification toggle, preserving pause/turn settings and chat state."""
import argparse
import http.cookiejar
import json
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('origin')
parser.add_argument('setting', choices=('on','off'))
args = parser.parse_args()
origin = args.origin.rstrip('/')
assert origin.startswith('https://')
owner = (Path(__file__).resolve().parent.parent / '.local/owner-access-code.txt').read_text().strip()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def request(path, payload=None):
    headers = {'Accept':'application/json'}
    if payload is not None:
        headers.update({'Content-Type':'application/json','Origin':origin})
    req = urllib.request.Request(origin+path, data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    try:
        with opener.open(req, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError('Owner notification request failed with HTTP '+str(error.code)) from None

logged_in = False
try:
    assert request('/api/login',{'access_code':owner})['participant'] == 'human'
    logged_in = True
    before = request('/api/room')
    target = args.setting == 'on'
    if target and not before['doorbell']['configured']:
        raise RuntimeError('Email delivery is not configured')
    result = request('/api/room',{'doorbell_enabled':target})
    assert result['doorbell']['enabled'] is target
    assert result['room']['paused'] == before['room']['paused']
    assert result['room']['turn_limit'] == before['room']['turn_limit']
    result = request('/api/room')
    assert result['doorbell']['enabled'] is target
    print(json.dumps({'doorbell':result['doorbell'],'room_paused':result['room']['paused'],'turn_limit':result['room']['turn_limit']},ensure_ascii=False))
finally:
    if logged_in:
        request('/api/logout',{})
