<?php
// Casa de cada cliente: el punto exacto donde lo recoges.
require __DIR__ . '/lib.php';
require_token();
$pdo = db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    $h = body();
    $phone = preg_replace('/\D/', '', (string) ($h['phone'] ?? ''));
    $lat = $h['lat'] ?? null;
    $lng = $h['lng'] ?? null;
    if (!preg_match('/^9\d{8}$/', $phone)) {
        fail('Número inválido');
    }
    if (!is_numeric($lat) || !is_numeric($lng) || abs((float) $lat) > 90 || abs((float) $lng) > 180) {
        fail('Coordenadas inválidas');
    }
    $acc = isset($h['acc']) && is_numeric($h['acc']) ? (int) round($h['acc']) : null;
    $note = mb_substr(trim((string) ($h['note'] ?? '')), 0, 120);
    $pdo->prepare('INSERT INTO homes (phone, lat, lng, acc, note) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE lat=VALUES(lat), lng=VALUES(lng), acc=VALUES(acc), note=VALUES(note)')
        ->execute([$phone, (float) $lat, (float) $lng, $acc, $note]);
    json_out(['ok' => true]);
}

if ($method === 'DELETE') {
    $pdo->prepare('DELETE FROM homes WHERE phone=?')->execute([preg_replace('/\D/', '', (string) ($_GET['phone'] ?? ''))]);
    json_out(['ok' => true]);
}

$rows = $pdo->query('SELECT phone, lat, lng, acc, note, updated_at FROM homes ORDER BY phone')->fetchAll();
foreach ($rows as &$r) {
    $r['lat'] = (float) $r['lat'];
    $r['lng'] = (float) $r['lng'];
    $r['acc'] = $r['acc'] === null ? null : (int) $r['acc'];
}
json_out($rows);
