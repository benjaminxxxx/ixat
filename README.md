# Taxi Radar

App web instalable (PWA) que lee los chats de WhatsApp del grupo de taxis, saca los servicios y avisa minutos antes dónde ponerse para los clientes que llaman siempre a la misma hora.

## Cómo funciona

```
.txt de WhatsApp ──► api/messages.php ──► MySQL (mensajes crudos, sin duplicados)
                                               │
              "Procesar todo" (navegador) ◄────┘
              js/processor.js  ──►  api/data/snapshot.json  ──►  celular
                                               │
                         api/cron.php ◄────────┘  (cada 1-5 min: manda los avisos)
```

- **Los mensajes crudos son la fuente de verdad.** Todo lo demás (servicios, clientes, hábitos, avisos) se recalcula desde cero con `js/processor.js`.
- **Cambios en zonas, lugares, eventos o chats** hacen que la app avise “Recalcular ahora” en todas las pantallas (y al salir de Zonas se recalcula sola).
- La hora de los mensajes se guarda sin segundos: así un chat exportado de distinto celular no se duplica.
- **Si cambias la lógica**, sube `LOGIC_VERSION` en `js/processor.js` y toca **Procesar todo** en la pestaña Datos.
- Subir el mismo chat varias veces no duplica nada: cada mensaje se reconoce por chat + fecha + remitente + texto.

## Uso diario

1. En WhatsApp: grupo → ⋮ → Más → Exportar chat → **Sin archivos**.
2. En la app (desde la PC): **Datos** → elegir día/noche → subir el `.txt` completo. Procesa solo.
3. **Zonas**: hay dos tipos:
   - **Zona (área)**: un barrio o terreno; se dibuja con un polígono.
   - **Lugar (punto)**: un negocio, grifo, hotel, etc. Se marca tocando el mapa o pegando la coordenada de Google Maps (`-15.8474, -74.2570` o el enlace completo). Si el punto cae dentro de una zona, sus pedidos cuentan también para esa zona.
   - Si dos nombres se parecen ("paraiso" / "alto paraiso"), gana la palabra clave más larga. Usa **Probar texto del chat** para verificar.
   - **🧹 Ordenar nombres** pone el tipo delante (Hostal…, Grifo…, Grass…, Pollería…) y junta lugares repetidos, conservando cómo los escriben en el chat. Las reglas están en `js/naming.js`.
   - Si estás en el lugar, toca **📍 Aquí** (usa el GPS del celular).
   - Luego toca **Reprocesar**.
4. **Casa del cliente**: en la ficha del cliente, al llegar a recogerlo toca **Estoy en su casa**. Desde entonces sus avisos dicen "Casa de…" y al tocarlos abren Google Maps directo a su puerta.
5. **Eventos** (Análisis → 🎉 Eventos): aniversarios, fiestas, feriados (botón para cargar los de Perú). Avisa 1 hora antes y, con el historial, muestra cuánto suben los pedidos. Reprocesa después de agregar eventos.
6. **Dónde esperar** (arriba en Ahora): eliges dónde estás (o GPS) y te dice si quedarte o moverte, con minutos esperados, km y costo de GLP. Se mide con los reportes "libre" del chat (servicios por hora de espera por zona). El costo por km está en `CONFIG.fuel` de `js/processor.js`.
7. **Ahora** usa el día de la semana: los sábados en la noche se comparan con otros sábados, no con el promedio. Arriba tiene un buscador de lugares con botón al mapa.

## Subir al hosting (Hostinger o cPanel)

1. Crea el subdominio (ej. `taxi.tudominio.com`) con SSL activado.
2. Crea una base de datos MySQL y su usuario en el panel.
3. Sube **todo** el contenido de esta carpeta (incluida `api/vendor/`) a la carpeta del subdominio.
4. Edita `api/config.php` en el servidor:
   - `db`: los datos de la base que creaste.
   - `token`: la clave de acceso (puedes dejar la misma).
   - `vapid.subject`: `mailto:` con tu correo. Las claves `public`/`private` se pueden dejar como están.
5. Asegúrate de que la carpeta `api/data/` tenga permiso de escritura (755).
6. Crea el cron:
   - **cPanel**: Cron Jobs → cada minuto → `php /home/USUARIO/public_html/taxi/api/cron.php`
   - **Hostinger**: hPanel → Avanzado → Cron Jobs → tipo PHP → `public_html/taxi/api/cron.php` (cada minuto o, si no deja, cada 5).
7. Abre en la PC `https://taxi.tudominio.com/?k=TU_CLAVE` → Datos → **Crear zonas sugeridas** → sube los dos chats.
8. Abre en el celular `https://taxi.tudominio.com/?k=TU_CLAVE`:
   - Android/Chrome: menú ⋮ → **Instalar app**.
   - iPhone/Safari: Compartir → **Agregar a inicio** (iOS 16.4+), y ábrela desde el ícono.
   - Datos → **Activar avisos** → **Enviar aviso de prueba**.

## Desarrollo local (Laragon)

- URL: `http://localhost/taxis/` (los avisos solo funcionan en `localhost` o con https).
- Primera vez: `php api/setup.php` crea `config.php`, las claves y las tablas.
  En Windows, si falla OpenSSL: `set OPENSSL_CONF=C:\laragon\bin\php\<version>\extras\ssl\openssl.cnf` antes de correrlo.
- Probar el cron a mano: `php api/cron.php`.

## Archivos

| Archivo | Qué hace |
|---|---|
| `js/parser.js` | Lee el `.txt` de WhatsApp (formato iPhone y Android) |
| `js/processor.js` | Toda la lógica: servicios, taxistas, turnos, hábitos, avisos |
| `js/seedZones.js` | Zonas iniciales y cómo las escriben en el chat |
| `js/naming.js` | Nombres estándar de lugares (Hostal…, Grifo…) |
| `js/events.js` | Fechas de eventos y feriados de Perú |
| `js/homes.js` | Casas de los clientes |
| `js/views/*.js` | Pantallas: Ahora, Análisis, Clientes, Zonas, Datos |
| `sw.js` | Funciona sin señal y muestra las notificaciones |
| `api/*.php` | Guarda mensajes, zonas, análisis y suscripciones; `cron.php` envía avisos |
