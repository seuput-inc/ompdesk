#!/usr/bin/env python3
"""Synthetic guest for the Unix CI lane test. All files live in the rig's empty directory."""
import hashlib
import json
import sys
from pathlib import Path


def emit(v, stream=sys.stdout):
    print(json.dumps(v), file=stream, flush=True)


op, spawn = sys.argv[15:17]
mode = Path('guest-mode').read_text()
journal = Path('guest-original')
if op == 'run':
    emit({'type': 'ompdesk-wsl-attached', 'invocationId': 'b' * 32, 'uid': 1001}, sys.stderr)
    launch = json.loads(input())
    key = launch['sessionKey']
    journal.write_text(json.dumps({'type': 'session', 'id': 'stock-test'}) + '\n')
    emit({'type': 'ompdesk-wsl-ready', 'spawnId': spawn}, sys.stderr)
    emit({'type': 'ready'})
    for line in sys.stdin:
        req = json.loads(line)
        ty = req['type']
        if ty == 'host_tool_result':
            assert req['isError'] and 'grant' in req['result']['content'][0]['text']
            Path('host-refused').touch()
            continue
        data = {}
        if ty == 'get_state':
            data = {'sessionId': 'stock-test', 'sessionFile': f'/home/fiction/.ompdesk-sessions/{key}/journal.jsonl', 'cwd': 'DO-NOT-FORWARD'}
        elif ty == 'prompt':
            assert req['message'] == 'fixture question' and 'env' not in req
            msg = {'role': 'assistant', 'timestamp': 7, 'content': [{'type': 'text', 'text': 'fixture answer'}]}
            with journal.open('a') as out:
                emit({'type': 'message', 'id': 'a1', 'parentId': None, 'message': msg}, out)
            emit({'type': 'host_tool_call', 'toolName': 'ompdesk_session_send', 'id': 'deny', 'arguments': {'path': 'DO-NOT-FORWARD'}})
            emit({'type': 'message_end', 'message': msg})
            emit({'type': 'agent_end', 'messages': [msg]})
        emit({'type': 'response', 'command': ty, 'id': req['id'], 'success': True, 'data': data})
elif op == 'bridge':
    print('OK', flush=True)
    emit({'event': {'type': 'desktop_slot_acquire', 'path': 'DO-NOT-FORWARD'}})
    for line in sys.stdin:
        req = json.loads(line)
        if req['method'] == 'wsl_admission':
            result = {'available': mode == 'ok', 'home': '/home/fiction'}
        else:
            assert req['method'] == 'sessions.attach_entry_ids'
            result = {'messages': [{**req['params']['messages'][0], 'entryId': 'a1'}]}
        emit({'id': req['id'], 'ok': True, 'result': result})
elif op == 'checkpoint':
    key, name, stock = sys.argv[-3:]
    assert (name, stock) == ('journal.jsonl', 'stock-test')
    data = journal.read_bytes()
    emit({'v': 1, 'sessionKey': key, 'spawnId': spawn, 'stockId': stock, 'source': '1:2', 'bytes': len(data)})
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    emit({'sha256': hashlib.sha256(data).hexdigest()})
elif op == 'stop':
    assert sys.argv[-2:] == ['b' * 32, '1001']
    print('unknown' if mode == 'unknown' else 'stopped', flush=True)
else:
    raise RuntimeError('unexpected guest operation')
