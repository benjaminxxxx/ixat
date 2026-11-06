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
    'token' => 'b830a16b04dc0efa',
    // Se generan con: php api/setup.php
    'vapid' => [
        'subject' => 'mailto:tu-correo@ejemplo.com',
        'public' => 'BL0veB6DBBSBzayZPkjf9T87uOPMOpkeWJARLRVVgNnX9itKtcT2b54-NlihO8vcSGyn3OjjccZWJHhuHPE-dWc',
        'private' => 'Q8h2QiIrbGsIdpP2cyJaEPAHe4xESuiUH1R1Jieu19Y',
    ],
];
