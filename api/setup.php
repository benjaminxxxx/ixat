<?php
// Uso (una sola vez):  php api/setup.php
// Crea config.php si no existe, genera claves VAPID para las notificaciones y crea las tablas.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Solo por consola');
}
require __DIR__ . '/vendor/autoload.php';

$file = __DIR__ . '/config.php';
if (!is_file($file)) {
    copy(__DIR__ . '/config.example.php', $file);
    echo "Creado api/config.php\n";
}
$cfg = require $file;

if (empty($cfg['vapid']['public'])) {
    $keys = Minishlink\WebPush\VAPID::createVapidKeys();
    $src = file_get_contents($file);
    $src = preg_replace("/'public' => '[^']*'/", "'public' => '{$keys['publicKey']}'", $src, 1);
    $src = preg_replace("/'private' => '[^']*'/", "'private' => '{$keys['privateKey']}'", $src, 1);
    if ($cfg['token'] === 'cambia-esta-clave') {
        $token = bin2hex(random_bytes(8));
        $src = str_replace("'cambia-esta-clave'", "'$token'", $src);
        echo "Clave de acceso de la app: $token\n";
    }
    file_put_contents($file, $src);
    echo "Claves VAPID generadas\n";
}

require __DIR__ . '/lib.php';
db();
echo "Tablas listas\n";
