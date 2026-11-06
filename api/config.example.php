<?php
// Copia este archivo como config.php y completa los datos.
return [
    'db' => [
        'host' => 'localhost',
        'name' => 'taxis',
        'user' => 'root',
        'pass' => '',
    ],
    // Clave que pide la app la primera vez (cámbiala por una larga).
    'token' => 'cambia-esta-clave',
    // Se generan con: php api/setup.php
    'vapid' => [
        'subject' => 'mailto:tu-correo@ejemplo.com',
        'public' => '',
        'private' => '',
    ],
];
