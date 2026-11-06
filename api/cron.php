<?php
// Ejecutar cada 1-5 minutos desde el cron del hosting:
//   php /ruta/a/taxis/api/cron.php
// Revisa la agenda de avisos del último análisis y manda los que tocan ahora.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Solo por consola');
}
require __DIR__ . '/push_lib.php';

$file = DATA_DIR . '/snapshot.json';
if (!is_file($file)) {
    exit("Sin análisis todavía\n");
}
$snap = json_decode(file_get_contents($file), true);
$alerts = $snap['alerts'] ?? [];

$now = new DateTimeImmutable('now');
$today = $now->format('Y-m-d');
$weekday = (int) $now->format('w'); // 0 = domingo
$nowMin = (int) $now->format('G') * 60 + (int) $now->format('i');
$windowMin = 6; // aguanta crons de cada 5 minutos

$pdo = db();
// Casas guardadas: el aviso abre Google Maps directo a la casa del cliente.
$homes = [];
foreach ($pdo->query('SELECT phone, lat, lng FROM homes') as $h) {
    $homes[$h['phone']] = $h;
}
$names = [];
foreach ($pdo->query('SELECT phone, name FROM client_names') as $n) {
    $names[$n['phone']] = $n['name'];
}
$mark = $pdo->prepare('INSERT IGNORE INTO push_log (alert_key, sent_date) VALUES (?,?)');
$sent = 0;
foreach ($alerts as $a) {
    if (isset($a['date'])) {
        if ($a['date'] !== $today) {
            continue; // evento con fecha fija
        }
    } elseif (!in_array($weekday, $a['days'], true)) {
        continue;
    }
    $diff = $nowMin - (int) $a['minute'];
    if ($diff < 0 || $diff >= $windowMin) {
        continue;
    }
    $mark->execute([$a['key'], $today]);
    if ($mark->rowCount() === 0) {
        continue; // ya se envió hoy
    }
    $title = $a['title'];
    $url = $a['url'] ?? './';
    $phone = $a['phone'] ?? null;
    if ($phone && isset($homes[$phone])) {
        $h = $homes[$phone];
        $title = '🏠 Casa de ' . preg_replace('/(\d{3})(\d{3})(\d{3})/', '$1 $2 $3', $phone) . ' · ' . preg_replace('/^📍\s*/u', '', $title);
        $url = sprintf('https://www.google.com/maps/dir/?api=1&destination=%.6f,%.6f', $h['lat'], $h['lng']);
    }
    $body = $a['body'];
    if ($phone && isset($names[$phone])) {
        $body = $names[$phone] . ' · ' . $body; // el apodo primero, para reconocerlo de un vistazo
    }
    $sent += push_all(['title' => $title, 'body' => $body, 'tag' => $a['key'], 'url' => $url]);
}
$pdo->exec("DELETE FROM push_log WHERE sent_date < CURDATE() - INTERVAL 7 DAY");
echo $now->format('Y-m-d H:i') . " avisos enviados: $sent\n";
