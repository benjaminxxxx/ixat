<?php
// Textos del chat que no son lugares ("alguien", "se editó este mensaje"): no vuelven a salir en Pendientes.
require __DIR__ . '/lib.php';
require_token();
$pdo = db();

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    $text = trim((string) (body()['text'] ?? ''));
    if ($text === '' || mb_strlen($text) > 190) {
        fail('Texto inválido');
    }
    $pdo->prepare('INSERT IGNORE INTO ignored_texts (text) VALUES (?)')->execute([$text]);
    json_out(['ok' => true]);
}

if ($method === 'DELETE') {
    $pdo->prepare('DELETE FROM ignored_texts WHERE text = ?')->execute([(string) ($_GET['text'] ?? '')]);
    json_out(['ok' => true]);
}

json_out($pdo->query('SELECT text FROM ignored_texts')->fetchAll(PDO::FETCH_COLUMN));
