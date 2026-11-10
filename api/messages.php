<?php
// Mensajes crudos del chat. Es la fuente de verdad: todo lo demás se recalcula desde aquí.
require __DIR__ . '/lib.php';
require_token();
$pdo = db();

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_GET['detect'])) {
    // { messages: [[ts, sender, text, n], ...] } (una muestra) → cuántos ya existen en cada chat.
    $b = body();
    $out = [];
    $chats = $pdo->query('SELECT DISTINCT chat FROM messages')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($chats as $chat) {
        $uids = [];
        foreach (array_slice((array) ($b['messages'] ?? []), 0, 500) as $m) {
            [$ts, $sender, $text, $n] = (array) $m + [null, null, null, 0];
            $ts = substr((string) $ts, 0, 16) . ':00';
            $uids[] = sha1("$chat|$ts|$sender|$text|$n");
        }
        if (!$uids) {
            continue;
        }
        $q = $pdo->prepare('SELECT COUNT(*) FROM messages WHERE uid IN (' . implode(',', array_fill(0, count($uids), '?')) . ')');
        $q->execute($uids);
        $out[$chat] = (int) $q->fetchColumn();
    }
    json_out(['sample' => min(500, count((array) ($b['messages'] ?? []))), 'matches' => $out]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // { chat, messages: [[ts, sender, text, n], ...] }  n = repetición del mismo mensaje en el mismo segundo
    $b = body();
    $chat = preg_replace('/[^a-z0-9_-]/', '', strtolower((string) ($b['chat'] ?? '')));
    if ($chat === '' || !is_array($b['messages'] ?? null)) {
        fail('Faltan chat o messages');
    }
    $stmt = $pdo->prepare('INSERT IGNORE INTO messages (chat, ts, sender, text, uid) VALUES (?,?,?,?,?)');
    $added = 0;
    $pdo->beginTransaction();
    foreach ($b['messages'] as $m) {
        [$ts, $sender, $text, $n] = $m + [null, null, null, 0];
        if (!preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/', (string) $ts)) {
            continue;
        }
        $ts = substr((string) $ts, 0, 16) . ':00'; // sin segundos (ver js/parser.js)
        $uid = sha1("$chat|$ts|$sender|$text|$n");
        $stmt->execute([$chat, $ts, mb_substr((string) $sender, 0, 150), (string) $text, $uid]);
        $added += $stmt->rowCount();
    }
    $pdo->commit();
    if ($added) {
        mark_changed();
    }
    json_out(['received' => count($b['messages']), 'added' => $added]);
}

if (isset($_GET['summary'])) {
    $rows = $pdo->query('SELECT chat, COUNT(*) n, MIN(ts) first, MAX(ts) last FROM messages GROUP BY chat')->fetchAll();
    json_out($rows);
}

if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    $chat = (string) ($_GET['chat'] ?? '');
    if ($chat === '*') {
        $pdo->exec('TRUNCATE messages');
    } else {
        $pdo->prepare('DELETE FROM messages WHERE chat = ?')->execute([$chat]);
    }
    json_out(['ok' => true]);
}

// GET por páginas: ?after=<id>&limit=<n>  → [[id, chat, ts, sender, text], ...]
$after = max(0, (int) ($_GET['after'] ?? 0));
$limit = min(50000, max(1, (int) ($_GET['limit'] ?? 20000)));
$stmt = $pdo->prepare("SELECT id, chat, DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') ts, sender, text FROM messages WHERE id > ? ORDER BY id LIMIT $limit");
$stmt->execute([$after]);
json_out(array_map('array_values', $stmt->fetchAll()));
