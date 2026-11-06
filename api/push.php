<?php
require __DIR__ . '/push_lib.php';
require_token();
$pdo = db();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (isset($_GET['test'])) {
        $n = push_all(['title' => 'Prueba de aviso', 'body' => 'Las notificaciones funcionan 👍', 'tag' => 'test']);
        json_out(['sent' => $n]);
    }
    $sub = body();
    if (empty($sub['endpoint'])) {
        fail('Suscripción inválida');
    }
    $pdo->prepare('INSERT INTO push_subs (hash, sub) VALUES (?,?) ON DUPLICATE KEY UPDATE sub=VALUES(sub)')
        ->execute([sha1($sub['endpoint']), json_encode($sub)]);
    json_out(['ok' => true]);
}

json_out([
    'publicKey' => config()['vapid']['public'],
    'subscribers' => (int) $pdo->query('SELECT COUNT(*) FROM push_subs')->fetchColumn(),
]);
