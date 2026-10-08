"""Room-owned data must not be accessible to unrelated logged-in users."""

import pytest


@pytest.mark.asyncio
async def test_nonmember_cannot_read_or_write_room_data(client, auth_headers):
    room = (await client.post('/api/v1/rooms', headers=auth_headers,
                              json={'name': 'Private room'})).json()['room']
    doc = (await client.post(f"/api/v1/rooms/{room['id']}/docs", headers=auth_headers,
                             json={'title': 'Private', 'content': 'private marker'})).json()['doc']
    outsider = (await client.post('/api/v1/auth/register',
                                  json={'username': 'outsider', 'display_name': 'Outsider', 'password': 'password123'})).json()
    headers = {'Authorization': f"Bearer {outsider['access_token']}"}
    base = f"/api/v1/rooms/{room['id']}"
    for endpoint in ['', '/docs', f"/docs/{doc['id']}", '/docs/search?q=private', '/files',
                     '/git/status', '/git/branch', '/git/log', '/git/diff', '/approvals']:
        response = await client.get(base + endpoint, headers=headers)
        assert response.status_code == 403, (endpoint, response.text)
    response = await client.post(base + '/docs', headers=headers,
                                 json={'title': 'Injected', 'content': 'unapproved'})
    assert response.status_code == 403
    response = await client.post(base + '/files/upload', headers=headers,
                                 files={'file': ('injected.txt', b'unapproved')})
    assert response.status_code == 403
    response = await client.post(base + '/approvals', headers=headers,
                                 json={'title': 'unapproved'})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_viewer_can_read_but_cannot_write_or_impersonate_author(client, auth_headers):
    room = (await client.post('/api/v1/rooms', headers=auth_headers,
                              json={'name': 'Read-only room'})).json()['room']
    viewer = (await client.post('/api/v1/auth/register',
                               json={'username': 'viewer', 'display_name': 'Viewer', 'password': 'password123'})).json()
    headers = {'Authorization': f"Bearer {viewer['access_token']}"}
    base = f"/api/v1/rooms/{room['id']}"
    await client.post(base + '/invite', headers=auth_headers,
                      json={'username': 'viewer', 'role': 'viewer'})
    assert (await client.get(base + '/docs', headers=headers)).status_code == 200
    assert (await client.get(base + '/files', headers=headers)).status_code == 200
    assert (await client.post(base + '/docs', headers=headers,
                              json={'title': 'No', 'content': 'No'})).status_code == 403
    forged = await client.post(base + '/docs', headers=auth_headers,
                               json={'title': 'No', 'content': 'No', 'author_id': viewer['user']['id']})
    assert forged.status_code == 403
