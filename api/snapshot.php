<?php
// Resultado del análisis (lo que ve el celular). Se guarda como archivo porque puede pesar varios MB.
require __DIR__ . '/lib.php';
require_token();

$file = DATA_DIR . '/snapshot.json';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: 'null', true);
    if (!is_array($data) || !isset($data['version'])) {
        fail('Snapshot inválido');
    }
    if (!is_dir(DATA_DIR)) {
        mkdir(DATA_DIR, 0755, true);
    }
    file_put_contents($file . '.tmp', $raw);
    rename($file . '.tmp', $file);
    json_out(['ok' => true, 'bytes' => strlen($raw)]);
}

if (!is_file($file)) {
    json_out(null);
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
readfile($file);
