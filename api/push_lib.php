<?php
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/vendor/autoload.php';

use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

// En Windows (Laragon) OpenSSL necesita su archivo de configuración para crear claves.
if (PHP_OS_FAMILY === 'Windows' && !getenv('OPENSSL_CONF')) {
    $cnf = dirname((string) php_ini_loaded_file()) . '/extras/ssl/openssl.cnf';
    if (is_file($cnf)) {
        putenv("OPENSSL_CONF=$cnf");
    }
}

/** Envía un aviso a todos los celulares suscritos. Devuelve cuántos llegaron. */
function push_all(array $payload): int
{
    $v = config()['vapid'];
    if (empty($v['public']) || empty($v['private'])) {
        throw new RuntimeException('Faltan las claves VAPID (php api/setup.php)');
    }
    $wp = new WebPush(['VAPID' => ['subject' => $v['subject'], 'publicKey' => $v['public'], 'privateKey' => $v['private']]]);
    $wp->setDefaultOptions(['TTL' => 900, 'urgency' => 'high']);

    $pdo = db();
    $subs = $pdo->query('SELECT id, sub FROM push_subs')->fetchAll();
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE);
    foreach ($subs as $s) {
        $wp->queueNotification(Subscription::create(json_decode($s['sub'], true)), $json);
    }
    $ok = 0;
    foreach ($wp->flush() as $report) {
        if ($report->isSuccess()) {
            $ok++;
        } elseif ($report->isSubscriptionExpired()) {
            $endpoint = $report->getEndpoint();
            foreach ($subs as $s) {
                if ((json_decode($s['sub'], true)['endpoint'] ?? '') === $endpoint) {
                    $pdo->prepare('DELETE FROM push_subs WHERE id=?')->execute([$s['id']]);
                }
            }
        }
    }
    return $ok;
}
