<?php
// ¿El análisis está al día? Compara la hora del último cambio (zonas, eventos, mensajes) con la del análisis.
require __DIR__ . '/lib.php';
require_token();
$changed = @filemtime(DATA_DIR . '/changed.txt') ?: 0;
$snapshot = @filemtime(DATA_DIR . '/snapshot.json') ?: 0;
json_out(['changed' => $changed, 'snapshot' => $snapshot, 'stale' => $changed > $snapshot]);
