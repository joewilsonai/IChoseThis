#!/usr/bin/env python3
"""Optional isolated real-API UI regression; requires Playwright and Chromium."""
import base64, http.cookiejar, json, os, struct, subprocess, tempfile, time, urllib.error, urllib.request, uuid, zlib
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
origin = 'http://localhost:4318'
owner = 'local-browser-owner-code-for-ui-integration-only'
errors = []
requests = []

# A small striped PNG used only as local QA data.
def png_bytes(width=360, height=220):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\0' + b''.join(bytes((180, 92, 74) if x < width//2 else (96, 145, 160)) for x in range(width)) for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

png = png_bytes()
attachment = {'base64':base64.b64encode(png).decode(), 'mime_type':'image/png', 'filename':'Local QA stripes.png'}
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def api(path, data=None, token=None):
    headers = {'Content-Type':'application/json', 'Origin':origin}
    if token: headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(origin + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
    return json.load(opener.open(request, timeout=10))

def post_message(data, token=None):
    return api('/api/rooms/elle-em/messages', {**data,'client_message_id':str(uuid.uuid4())}, token)['message']

with tempfile.TemporaryDirectory(prefix='ichosethis-ui-browser-') as tmp:
    with open(Path(tmp)/'server.log','w+') as log:
        env = {**os.environ,'PORT':'4318','APP_ORIGIN':origin,'DATABASE_PATH':str(Path(tmp)/'relay.sqlite'),'OWNER_ACCESS_CODE':owner}
        server = subprocess.Popen(['node','scripts/local-server.mjs'], cwd=root, env=env, stdout=log, stderr=log)
        try:
            for attempt in range(100):
                try:
                    if urllib.request.urlopen(origin+'/health',timeout=1).status == 200: break
                except Exception:
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    time.sleep(.05)
            else: raise RuntimeError('Local relay failed to start')
            api('/api/login',{'access_code':owner})
            em = api('/api/keys',{'participant':'em'})['token']
            elle = api('/api/keys',{'participant':'elle'})['token']
            first = post_message({'content':'Opening shot. Your move, Elle.','recipient':'all','images':[attachment]},em)
            second = post_message({'content':'Challenge accepted. This is only the beginning.','recipient':'all'},elle)
            quoted = post_message({'content':'The pic war has officially begun.','recipient':'all','reply_to':first['seq']})
            post_message({'type':'reaction','message_seq':first['seq'],'emoji':'😈','active':True},em)
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
                page = browser.new_page(viewport={'width':1280,'height':900})
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.on('console',lambda message:errors.append(message.text) if message.type == 'error' else None)
                page.on('request',lambda request:requests.append(request.post_data_json) if request.method == 'POST' and request.url == origin+'/api/rooms/elle-em/messages' else None)
                page.goto(origin,wait_until='domcontentloaded')
                page.locator('#access-code').fill(owner)
                page.locator('#login-button').click()
                page.wait_for_selector('#message-'+str(quoted['seq']))
                assert page.locator('article.message').count() == 3, 'Reaction rendered as a chat bubble'
                assert page.locator('#gallery-strip button').count() == 1
                assert page.locator('#message-'+str(quoted['seq'])+' .quoted-message').inner_text().startswith('Em\nOpening shot.')
                expect(page.locator('#gallery-strip img')).to_have_js_property('naturalWidth', 360)
                page.locator('#gallery-strip button').click()
                assert page.locator('#image-dialog').evaluate('(e) => e.open')
                expect(page.locator('#full-image')).to_have_js_property('naturalWidth', 360)
                assert 'Em' in page.locator('#image-caption').inner_text()
                page.locator('#close-image').click()
                page.locator('#message-'+str(first['seq'])+' button.message-action',has_text='Reply').click()
                assert page.locator('#composer-reply').is_visible()
                page.locator('#image-input').set_input_files({'name':'Browser QA.png','mimeType':'image/png','buffer':png})
                assert page.locator('#attachment-previews img').count() == 1
                page.locator('#send-button').click()
                expect(page.locator('#gallery-strip button')).to_have_count(2)
                assert requests[-1]['content'] == '' and requests[-1]['reply_to'] == first['seq']
                assert base64.b64decode(requests[-1]['images'][0]['base64']) == png
                assert page.locator('#attachment-previews').is_hidden()
                assert page.locator('#composer-reply').is_hidden()
                assert page.locator('article.message').count() == 4
                reaction = page.locator('#message-'+str(first['seq'])+' button.reaction-tag')
                reaction.click()
                expect(page.locator('#message-1 .reaction-tag')).to_have_text('😈 2')
                assert page.locator('#message-1 .reaction-tag').get_attribute('aria-pressed') == 'true'
                page.locator('#message-1 .reaction-tag').click()
                expect(page.locator('#message-1 .reaction-tag')).to_have_text('😈 1')
                assert page.locator('article.message').count() == 4
                post_message({'type':'reaction','message_seq':first['seq'],'emoji':'❤️','active':True},em)
                expect(page.locator('#message-1 .reaction-tag', has_text='❤️ 1')).to_be_visible(timeout=10000)
                assert page.locator('article.message').count() == 4
                # One local failure verifies the draft, image and exact request ID survive a retry.
                failed = {'value':False}
                def fail_once(route):
                    data = route.request.post_data_json
                    if data.get('content') == 'Retry me' and not failed['value']:
                        failed['value'] = True
                        route.fulfill(status=503,json={'message':'Temporary local QA failure'})
                    else: route.continue_()
                page.route(origin+'/api/rooms/elle-em/messages',fail_once)
                page.locator('#message-2 button.message-action',has_text='Reply').click()
                page.locator('#image-input').set_input_files({'name':'Retry QA.png','mimeType':'image/png','buffer':png})
                page.locator('#message-input').fill('Retry me')
                page.locator('#send-button').click()
                expect(page.locator('#composer-status')).to_contain_text('Temporary local QA failure')
                failed_id = requests[-1]['client_message_id']
                assert page.locator('#attachment-previews img').count() == 1
                assert page.locator('#composer-reply').is_visible()
                page.locator('#message-input').fill('Retry me altered')
                page.locator('#message-input').fill('Retry me')
                page.locator('#send-button').click()
                expect(page.locator('#message-input')).to_have_value('')
                assert requests[-1]['client_message_id'] == failed_id
                assert page.locator('#attachment-previews').is_hidden()
                assert page.locator('#gallery-strip button').count() == 3
                # Gallery navigation and mobile geometry with actual loaded images.
                page.locator('#gallery-strip button').nth(1).click()
                page.locator('#next-image').click()
                assert page.locator('#image-position').inner_text() == '3 of 3'
                page.locator('#close-image').click()
                composer = page.locator('#composer').bounding_box()
                assert composer['y'] + composer['height'] <= 900, 'Desktop composer below viewport'
                page.screenshot(path='/tmp/ichosethis-real-ui-desktop.png')
                for width in (390,320):
                    page.set_viewport_size({'width':width,'height':844})
                    page.wait_for_timeout(100)
                    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'Document overflow at {width}px'
                    assert page.locator('#send-button').is_visible()
                    assert page.locator('#attach-button').is_visible()
                    bounds = page.locator('#composer').bounding_box()
                    assert bounds['x'] >= 0 and bounds['x']+bounds['width'] <= width, f'Composer overflow at {width}px: {bounds}'
                    for selector in ('#send-button','#attach-button','#recipient','#pause-button','#mobile-connections-button'):
                        button = page.locator(selector).bounding_box()
                        assert button['x'] >= 0 and button['x']+button['width'] <= width, f'{selector} offscreen at {width}px: {button}'
                        assert button['height'] >= 44, f'{selector} too small to tap at {width}px'
                    assert page.locator('#message-input').evaluate('(e) => parseFloat(getComputedStyle(e).fontSize)') >= 16
                    assert bounds['y'] + bounds['height'] <= 844, 'Phone composer below viewport'
                    page.screenshot(path=f'/tmp/ichosethis-real-ui-mobile-{width}.png')
                page.locator('#mobile-connections-button').click()
                expect(page.locator('#doorbell-status')).to_have_text('Email delivery is not configured.')
                expect(page.locator('#doorbell-enable')).to_be_disabled()
                expect(page.locator('#doorbell-enable')).not_to_be_checked()
                page.locator('#doorbell-status').scroll_into_view_if_needed()
                dialog = page.locator('#connections-dialog').bounding_box()
                assert dialog['x'] >= 0 and dialog['x'] + dialog['width'] <= 320
                assert dialog['y'] >= 0 and dialog['y'] + dialog['height'] <= 844
                page.locator('#close-dialog').click()
                # A touch context verifies mobile Enter behavior and a reduced
                # visual viewport without relying on a real device keyboard.
                phone = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
                phone.add_init_script("""Object.defineProperty(window.visualViewport, 'height', {configurable:true,get:()=>window.testKeyboardHeight || window.innerHeight});""")
                mobile = phone.new_page()
                mobile.goto(origin,wait_until='domcontentloaded')
                mobile.locator('#access-code').fill(owner)
                mobile.locator('#login-button').click()
                expect(mobile.locator('#composer')).to_be_visible()
                mobile.locator('#message-input').fill('Mobile draft')
                mobile.locator('#message-input').press('Enter')
                expect(mobile.locator('#message-input')).to_have_value('Mobile draft\n')
                mobile.evaluate("window.testKeyboardHeight = 335; window.visualViewport.dispatchEvent(new Event('resize'))")
                expect(mobile.locator('#gallery')).to_be_hidden()
                for selector in ('#composer','#send-button','#attach-button'):
                    bounds = mobile.locator(selector).bounding_box()
                    assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= 336, f'{selector} outside reduced keyboard viewport: {bounds}'
                mobile.screenshot(path='/tmp/ichosethis-real-ui-keyboard.png')
                phone.close()
                assert sorted(errors) == sorted(['Failed to load resource: the server responded with a status of 401 (Unauthorized)', 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)']), errors
                final = api('/api/rooms/elle-em/transcript?after=0&limit=100')
                assert len([event for event in final['messages'] if event.get('type') == 'message']) == 5
                print('Real API UI QA passed: login, images, quotes, gallery, reactions and retry preservation; desktop composer fits; mobile 390/320px controls fit with 44px targets and 16px inputs; settings fit; touch Enter keeps draft; simulated 335px keyboard viewport keeps composer and controls visible. Only intentional 401/503 console responses observed.')
                print('Screenshots: /tmp/ichosethis-real-ui-desktop.png, /tmp/ichosethis-real-ui-mobile-390.png, /tmp/ichosethis-real-ui-mobile-320.png')
                browser.close()
        finally:
            server.terminate()
            try: server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
