<?php
// Eventos programados y feriados: sirven para avisar y para medir cuánto suben los pedidos.
require __DIR__ . '/lib.php';
require_token();
$pdo = db();
$method = $_SERVER['REQUEST_METHOD'];

function event_row(array $e): array
{
    $name = mb_substr(trim((string) ($e['name'] ?? '')), 0, 120);
    $date = (string) ($e['date'] ?? '');
    if ($name === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        fail('Necesita nombre y fecha');
    }
    $from = max(0, min(1439, (int) ($e['from_min'] ?? 0)));
    $to = max(0, min(1439, (int) ($e['to_min'] ?? 1439)));
    $zone = isset($e['zone_id']) && $e['zone_id'] !== '' && $e['zone_id'] !== null ? (int) $e['zone_id'] : null;
    $note = mb_substr(trim((string) ($e['note'] ?? '')), 0, 200);
    return [$name, $date, $from, $to, $zone, !empty($e['yearly']) ? 1 : 0, $note];
}

if ($method === 'POST') {
    $b = body();
    // Varios a la vez (feriados): {list:[...]}; no repite los que ya existen con mismo nombre y fecha.
    $list = isset($b['list']) ? (array) $b['list'] : [$b];
    $added = 0;
    $id = 0;
    foreach ($list as $e) {
        $row = event_row((array) $e);
        if (!empty($e['id'])) {
            $pdo->prepare('UPDATE events SET name=?, date=?, from_min=?, to_min=?, zone_id=?, yearly=?, note=? WHERE id=?')
                ->execute([...$row, (int) $e['id']]);
            $id = (int) $e['id'];
            continue;
        }
        $dup = $pdo->prepare('SELECT id FROM events WHERE name=? AND (date=? OR (yearly=1 AND DATE_FORMAT(date, "%m-%d")=DATE_FORMAT(?, "%m-%d")))');
        $dup->execute([$row[0], $row[1], $row[1]]);
        if ($dup->fetchColumn()) {
            continue;
        }
        $pdo->prepare('INSERT INTO events (name, date, from_min, to_min, zone_id, yearly, note) VALUES (?,?,?,?,?,?,?)')->execute($row);
        $id = (int) $pdo->lastInsertId();
        $added++;
    }
    mark_changed();
    json_out(['id' => $id, 'added' => $added]);
}

if ($method === 'DELETE') {
    $pdo->prepare('DELETE FROM events WHERE id=?')->execute([(int) ($_GET['id'] ?? 0)]);
    mark_changed();
    json_out(['ok' => true]);
}

$rows = $pdo->query('SELECT id, name, date, from_min, to_min, zone_id, yearly, note FROM events ORDER BY date, from_min')->fetchAll();
foreach ($rows as &$r) {
    foreach (['id', 'from_min', 'to_min', 'yearly'] as $k) {
        $r[$k] = (int) $r[$k];
    }
    $r['zone_id'] = $r['zone_id'] === null ? null : (int) $r['zone_id'];
}
json_out($rows);
