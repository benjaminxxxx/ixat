<?php
// Apodos de los clientes. Nombre vacío = quitar el apodo.
require __DIR__ . '/lib.php';
require_token();
$pdo = db();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $b = body();
    $phone = preg_replace('/\D/', '', (string) ($b['phone'] ?? ''));
    if (!preg_match('/^9\d{8}$/', $phone)) {
        fail('Número inválido');
    }
    $name = mb_substr(trim((string) ($b['name'] ?? '')), 0, 60);
    if ($name === '') {
        $pdo->prepare('DELETE FROM client_names WHERE phone=?')->execute([$phone]);
    } else {
        $pdo->prepare('INSERT INTO client_names (phone, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)')->execute([$phone, $name]);
    }
    json_out(['ok' => true]);
}

json_out($pdo->query('SELECT phone, name FROM client_names ORDER BY name')->fetchAll());
