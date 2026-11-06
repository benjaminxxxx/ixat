<?php
declare(strict_types=1);
date_default_timezone_set('America/Lima');

const DATA_DIR = __DIR__ . '/data';

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $file = __DIR__ . '/config.php';
        if (!is_file($file)) {
            fail('Falta api/config.php (copia config.example.php)', 500);
        }
        $cfg = require $file;
    }
    return $cfg;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = config()['db'];
        $pdo = new PDO(
            "mysql:host={$c['host']};dbname={$c['name']};charset=utf8mb4",
            $c['user'],
            $c['pass'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
        $pdo->exec("SET time_zone = '-05:00'");
        ensure_schema($pdo);
    }
    return $pdo;
}

function ensure_schema(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        chat VARCHAR(20) NOT NULL,
        ts DATETIME NOT NULL,
        sender VARCHAR(150) NOT NULL,
        text TEXT NOT NULL,
        uid CHAR(40) NOT NULL,
        UNIQUE KEY uq_uid (uid),
        KEY k_chat_ts (chat, ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS zones (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        aliases TEXT NOT NULL,
        polygon MEDIUMTEXT NULL,
        color VARCHAR(10) NOT NULL DEFAULT '#e0a800',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    // v2: zonas (polígono) y lugares (punto) en la misma tabla.
    $cols = $pdo->query("SHOW COLUMNS FROM zones")->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('kind', $cols, true)) {
        $pdo->exec("ALTER TABLE zones ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'zona' AFTER name, ADD COLUMN lat DOUBLE NULL, ADD COLUMN lng DOUBLE NULL");
    }
    $pdo->exec("CREATE TABLE IF NOT EXISTS push_subs (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        hash CHAR(40) NOT NULL,
        sub TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_hash (hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // Apodo de cada cliente ("Doña Rosa", "Ingeniero mina").
    $pdo->exec("CREATE TABLE IF NOT EXISTS client_names (
        phone VARCHAR(12) PRIMARY KEY,
        name VARCHAR(60) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    // Casa (punto exacto de recojo) de cada cliente.
    $pdo->exec("CREATE TABLE IF NOT EXISTS homes (
        phone VARCHAR(12) PRIMARY KEY,
        lat DOUBLE NOT NULL,
        lng DOUBLE NOT NULL,
        acc INT NULL,
        note VARCHAR(120) NOT NULL DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    // Eventos y feriados (aniversarios, Navidad…): fecha, rango de horas y zona opcional.
    $pdo->exec("CREATE TABLE IF NOT EXISTS events (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        date DATE NOT NULL,
        from_min SMALLINT NOT NULL,
        to_min SMALLINT NOT NULL,
        zone_id INT NULL,
        yearly TINYINT(1) NOT NULL DEFAULT 0,
        note VARCHAR(200) NOT NULL DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS push_log (
        alert_key VARCHAR(120) NOT NULL,
        sent_date DATE NOT NULL,
        PRIMARY KEY (alert_key, sent_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    json_out(['error' => $msg], $code);
}

function require_token(): void
{
    $sent = $_SERVER['HTTP_X_TOKEN'] ?? ($_GET['token'] ?? '');
    if (!hash_equals((string) config()['token'], (string) $sent)) {
        fail('Clave incorrecta', 401);
    }
}

function body(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: 'null', true);
    if (!is_array($data)) {
        fail('JSON inválido');
    }
    return $data;
}
