<?php
// Zonas (área con polígono) y lugares (un punto). Ambos tienen las palabras con las que aparecen en el chat.
require __DIR__ . '/lib.php';
require_token();
$pdo = db();

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    $z = body();
    $name = trim((string) ($z['name'] ?? ''));
    if ($name === '') {
        fail('Necesita nombre');
    }
    $kind = ($z['kind'] ?? 'zona') === 'lugar' ? 'lugar' : 'zona';
    $aliases = json_encode(array_values(array_unique(array_filter(array_map('trim', (array) ($z['aliases'] ?? []))))), JSON_UNESCAPED_UNICODE);
    $polygon = !empty($z['polygon']) ? json_encode($z['polygon']) : null;
    $lat = isset($z['lat']) && is_numeric($z['lat']) && abs((float) $z['lat']) <= 90 ? (float) $z['lat'] : null;
    $lng = isset($z['lng']) && is_numeric($z['lng']) && abs((float) $z['lng']) <= 180 ? (float) $z['lng'] : null;
    $color = preg_match('/^#[0-9a-f]{6}$/i', (string) ($z['color'] ?? '')) ? $z['color'] : '#e0a800';
    if (!empty($z['id'])) {
        $pdo->prepare('UPDATE zones SET name=?, kind=?, aliases=?, polygon=?, lat=?, lng=?, color=? WHERE id=?')
            ->execute([$name, $kind, $aliases, $polygon, $lat, $lng, $color, (int) $z['id']]);
        $id = (int) $z['id'];
    } else {
        $pdo->prepare('INSERT INTO zones (name, kind, aliases, polygon, lat, lng, color) VALUES (?,?,?,?,?,?,?)')
            ->execute([$name, $kind, $aliases, $polygon, $lat, $lng, $color]);
        $id = (int) $pdo->lastInsertId();
    }
    mark_changed();
    json_out(['id' => $id]);
}

if ($method === 'DELETE') {
    $pdo->prepare('DELETE FROM zones WHERE id=?')->execute([(int) ($_GET['id'] ?? 0)]);
    mark_changed();
    json_out(['ok' => true]);
}

$rows = $pdo->query('SELECT id, name, kind, aliases, polygon, lat, lng, color FROM zones ORDER BY name')->fetchAll();
foreach ($rows as &$r) {
    $r['id'] = (int) $r['id'];
    $r['aliases'] = json_decode($r['aliases'], true) ?: [];
    $r['polygon'] = $r['polygon'] ? json_decode($r['polygon'], true) : null;
    $r['lat'] = $r['lat'] === null ? null : (float) $r['lat'];
    $r['lng'] = $r['lng'] === null ? null : (float) $r['lng'];
}
json_out($rows);
