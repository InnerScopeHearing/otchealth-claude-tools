#!/usr/bin/env python3
"""Read-only AgentCore Browser endpoint preflight. AWS credentials are injected at runtime."""
import datetime as dt
import hashlib
import hmac
import json
import os
import urllib.request

access = os.environ['AWS_ACCESS_KEY_ID']
secret = os.environ['AWS_SECRET_ACCESS_KEY']
token = os.environ.get('AWS_SESSION_TOKEN')
region = os.environ.get('AWS_REGION', 'us-east-1')
service = 'bedrock-agentcore'
host = f'bedrock-agentcore.{region}.amazonaws.com'

def mac(key, text): return hmac.new(key, text.encode(), hashlib.sha256).digest()
def signing_key(day):
    key = mac(('AWS4' + secret).encode(), day)
    key = mac(key, region)
    key = mac(key, service)
    return mac(key, 'aws4_request')

now = dt.datetime.now(dt.timezone.utc)
stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
headers = {'host': host, 'x-amz-date': stamp}
if token: headers['x-amz-security-token'] = token
signed = ';'.join(sorted(headers))
canon_headers = ''.join(f'{key}:{headers[key]}\n' for key in sorted(headers))
payload_hash = hashlib.sha256(b'').hexdigest()
canonical = f'GET\n/browsers\n\n{canon_headers}\n{signed}\n{payload_hash}'
scope = f'{day}/{region}/{service}/aws4_request'
string = f'AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
signature = hmac.new(signing_key(day), string.encode(), hashlib.sha256).hexdigest()
headers['Authorization'] = f'AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={signature}'
try:
    urllib.request.urlopen(urllib.request.Request(f'https://{host}/browsers', headers=headers), timeout=30)
    status = 200
except urllib.error.HTTPError as error:
    status = error.code
print(json.dumps({'region': region, 'endpoint': host, 'reachable': status in (200, 400, 403, 404), 'http_status': status, 'credentials_exposed': False}))
