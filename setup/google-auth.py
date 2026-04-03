#!/usr/bin/env python3
"""
One-time Google Calendar OAuth2 setup.

Before running:
  1. Go to https://console.cloud.google.com
  2. Create a project (or use an existing one)
  3. Enable the Google Calendar API
  4. Go to APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID
  5. Choose "Desktop app", download the JSON, save it as:
       /mnt/nas/config/google-auth/credentials.json

Then run:
  python3 setup/google-auth.py

This will open a browser for authorization and write token.json to the same directory.
"""

import json
import sys
import time
import http.server
import threading
import webbrowser
import urllib.parse
import urllib.request
from pathlib import Path

GOOGLE_AUTH_DIR = Path('/mnt/nas/config/google-auth')
CREDS_PATH = GOOGLE_AUTH_DIR / 'credentials.json'
TOKEN_PATH = GOOGLE_AUTH_DIR / 'token.json'

SCOPES = 'https://www.googleapis.com/auth/calendar.readonly'
REDIRECT_URI = 'http://localhost:8080'


def main():
    if not CREDS_PATH.exists():
        print(f'credentials.json not found at {CREDS_PATH}')
        print('Download it from GCP Console > APIs & Services > Credentials > OAuth 2.0 Client ID')
        sys.exit(1)

    creds = json.loads(CREDS_PATH.read_text())
    installed = creds.get('installed') or creds.get('web')
    if not installed:
        print('Unexpected credentials.json format — expected "installed" or "web" key')
        sys.exit(1)

    client_id = installed['client_id']
    client_secret = installed['client_secret']

    # Build authorization URL
    auth_params = {
        'client_id': client_id,
        'redirect_uri': REDIRECT_URI,
        'response_type': 'code',
        'scope': SCOPES,
        'access_type': 'offline',
        'prompt': 'consent',
    }
    auth_url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(auth_params)

    # Start a local HTTP server to catch the redirect
    code_holder = [None]

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            code_holder[0] = qs.get('code', [None])[0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'<html><body><h2>Authorization complete.</h2><p>You can close this window.</p></body></html>')

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(('localhost', 8080), Handler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()

    print('Opening browser for Google authorization...')
    webbrowser.open(auth_url)
    print(f'If the browser did not open, visit:\n  {auth_url}\n')

    thread.join(timeout=120)

    if not code_holder[0]:
        print('No authorization code received within 120 seconds. Aborting.')
        sys.exit(1)

    # Exchange authorization code for tokens
    token_params = urllib.parse.urlencode({
        'code': code_holder[0],
        'client_id': client_id,
        'client_secret': client_secret,
        'redirect_uri': REDIRECT_URI,
        'grant_type': 'authorization_code',
    }).encode()

    req = urllib.request.Request(
        'https://oauth2.googleapis.com/token',
        data=token_params,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    try:
        resp = json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        print(f'Token exchange failed: {e.read().decode()}')
        sys.exit(1)

    if 'refresh_token' not in resp:
        print('No refresh_token in response. Try revoking access at accounts.google.com and re-running.')
        sys.exit(1)

    token = {
        'access_token': resp['access_token'],
        'refresh_token': resp['refresh_token'],
        'token_type': resp.get('token_type', 'Bearer'),
        'expiry_date': int(time.time() * 1000) + resp['expires_in'] * 1000,
        'client_id': client_id,
        'client_secret': client_secret,
    }

    GOOGLE_AUTH_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps(token, indent=2))
    print(f'Token saved to {TOKEN_PATH}')
    print('Google Calendar access is ready.')


if __name__ == '__main__':
    main()
