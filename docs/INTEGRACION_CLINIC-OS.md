# Integración Diagnostic OS ⇄ Clinic-OS

Este documento es el **contrato** entre las dos aplicaciones. Está escrito para quien mantiene Clinic-OS y para quien configura la conexión. Todo lo que aparece aquí está cubierto por pruebas automáticas (`npm test`) que corren Diagnostic OS contra un "Clinic-OS de mentira" con este mismo contrato.

```
 Clinic-OS ── (1) orden de examen ──▶ Diagnostic OS     POST /api/fhir/tenants/{tenantId}/ServiceRequest   (clave X-API-Key)
 Clinic-OS ◀── (2) informe publicado ── Diagnostic OS   POST {URL base}/DiagnosticReport                    (OAuth2 client_credentials)
```

## 1. Qué hace falta del lado de Clinic-OS

### 1.1 Recibir informes: `POST {URL base}/DiagnosticReport`
- **Autenticación:** `Authorization: Bearer <access_token>` con scope `system/DiagnosticReport.write`.
- **Token:** `POST {URL base}/oauth/token` (o la URL que se configure). Diagnostic OS envía JSON
  `{"grant_type":"client_credentials","client_id":"…","client_secret":"…","scope":"system/DiagnosticReport.write"}`.
  Si el servidor lo rechaza (400/401 `invalid_client`), prueba solo con formulario `x-www-form-urlencoded` y luego con HTTP Basic, y recuerda cuál funcionó. Respuesta esperada: `{"access_token":"…","expires_in":900}`.
  Si un envío recibe **401**, renueva el token una vez y reintenta.
- **Cómo emparejar el informe** (siempre por identificadores, nunca por ids internos de Diagnostic OS):
  | Dato | Dónde viene |
  |---|---|
  | Paciente | `subject.identifier` → `system: "urn:ec:cedula"`, `value: <cédula>` |
  | Orden original | `basedOn[0].identifier` → `system: "urn:clinicos:lab-order"`, `value: <id de la lab_order>` (el mismo valor que Clinic-OS envió en `ServiceRequest.identifier[0].value`) |
  | Texto del resultado | `conclusion` (conclusión + valores del examen en texto, máx. ~3800 caracteres) |
  | Versión | `meta.versionId` (empieza en `"1"`; sube con cada corrección republicada) |
  | Identidad del informe | `id` y `identifier[0].value` (mismo valor) |
- **Idempotencia (importante):** puede llegar el mismo informe más de una vez (reintentos). Deduplicar por **`id` + `meta.versionId`**. Cada POST lleva además el encabezado `Idempotency-Key: <id>:v<versión>`. Una versión nueva del mismo `id` **reemplaza** al resultado anterior.
- **Códigos de respuesta y qué hace Diagnostic OS con cada uno:**
  | Respuesta | Resultado en Diagnostic OS |
  |---|---|
  | `200` / `201` | Entregado (estado *Confirmado*) |
  | `409` | Entregado (el destino ya tenía esa versión) |
  | `401` | Renueva el token y reintenta una vez; si persiste, *Error* sin reintento automático |
  | `400` `403` `404` `422` | *Error* **sin** reintento automático (hay que corregir algo y pulsar *Reintentar*) |
  | `408` `425` `429` `5xx`, sin red, timeout (15 s) | *Error* con **reintento automático**: a 1, 5, 15, 60 y 240 minutos (máx. 6 intentos) |
  Si el cuerpo de un error es un `OperationOutcome`, su `issue[0].diagnostics` se muestra en el panel de Diagnostic OS: **usa mensajes claros** (p. ej. "No existe una orden con id 42").
- **Un informe nuevo puede llegar antes de que Clinic-OS "esté listo"**: responde `404`/`422` solo si de verdad no puede emparejarlo.

Ejemplo real de lo que se envía (generado por el código):

```json
{
  "resourceType": "DiagnosticReport",
  "id": "cm1abc",
  "meta": {
    "versionId": "1"
  },
  "identifier": [
    {
      "system": "urn:diagnostic-os:report",
      "value": "cm1abc"
    }
  ],
  "status": "final",
  "category": [
    {
      "coding": [
        {
          "system": "http://terminology.hl7.org/CodeSystem/v2-0074",
          "code": "LAB",
          "display": "Laboratory"
        }
      ]
    }
  ],
  "code": {
    "coding": [
      {
        "system": "urn:diagnostic-os:service",
        "code": "LAB-HEMO",
        "display": "Hemograma completo"
      }
    ],
    "text": "Hemograma completo"
  },
  "subject": {
    "identifier": {
      "system": "urn:ec:cedula",
      "value": "0912345678"
    }
  },
  "basedOn": [
    {
      "identifier": {
        "system": "urn:clinicos:lab-order",
        "value": "42"
      }
    }
  ],
  "effectiveDateTime": "2026-10-15T15:30:00.000Z",
  "performer": [
    {
      "display": "Laboratorio Clínico San Rafael"
    }
  ],
  "conclusion": "Leucocitosis.\n\nResultados:\n- Hemoglobina: 13.2 g/dL (ref. 12-16)\n- Leucocitos: 15.1 10^3/µL (ref. 4-11) [ALTO]"
}
```

Notas:
- Los informes de **imágenes** envían en `conclusion`: `Hallazgos: …` + `Impresión: …`.
- Si la orden **no vino de Clinic-OS** (sin identificador externo) o el paciente **no tiene cédula**, Diagnostic OS **no envía nada** y lo registra como *No enviado* con el motivo.
- Los valores estructurados (`Observation`) y los adjuntos (PDF) están disponibles como **fase 2**: poner `INTEGRATION_PAYLOAD_PROFILE=full` en el servidor de Diagnostic OS los añade (`contained` Observations, `result`, `presentedForm` con URL de cada archivo). Mientras Clinic-OS no los use, se mantiene el perfil por defecto.

### 1.2 Enviar órdenes: `POST /api/fhir/tenants/{tenantId}/ServiceRequest`
- **Autenticación:** encabezado `X-API-Key: <clave>` (también acepta `Authorization: Bearer <clave>`). La clave la genera el superadmin en *Integraciones → Generar clave*; se muestra **una sola vez**.
- **Contenido:** un `ServiceRequest` con el `Patient` en `contained`, o un `Bundle` (con un `Patient` y varios `ServiceRequest` = una orden con varios estudios).
  ```json
  {
    "resourceType": "ServiceRequest", "id": "42", "status": "active", "intent": "order", "priority": "routine",
    "identifier": [{ "system": "urn:clinicos:lab-order", "value": "42" }],
    "code": { "coding": [{ "system": "urn:diagnostic-os:service", "code": "LAB-HEMO" }], "text": "Hemograma completo" },
    "subject": { "reference": "#pat" },
    "requester": { "display": "Dr. Pérez" },
    "reasonCode": [{ "text": "Control" }],
    "contained": [{
      "resourceType": "Patient", "id": "pat",
      "identifier": [{ "system": "urn:ec:cedula", "value": "0912345678" }],
      "name": [{ "family": "Mora", "given": ["Ana"] }], "gender": "female", "birthDate": "1990-05-01"
    }]
  }
  ```
- **`identifier[0].value` es obligatorio en la práctica:** es lo que Diagnostic OS devuelve después en `basedOn`. Debe ser el id de la `lab_order` en Clinic-OS.
- **Paciente:** se empareja por cédula (el identificador cuyo `system` contiene "cedula"; si no hay, el primero). Si no existe, se crea en estado *pendiente de confirmar*.
- **Estudio:** se busca en el catálogo del centro, en este orden: (1) `code.coding[].code` igual al código del catálogo (ej. `LAB-HEMO`), (2) código externo del catálogo (ej. `LOINC:58410-2`), (3) nombre exacto (sin tildes ni mayúsculas). **Lo más fiable es usar los códigos del catálogo de Diagnostic OS.** Si no se encuentra, la orden se crea igual con un estudio "sin catálogo" y la respuesta trae un `issue` de tipo `warning`.
- **Respuestas:** `201` creada · `200` ya existía (reenviar la misma orden **no** la duplica) · `401` clave inválida · `400`/`422` datos incompletos. Todas las respuestas de error son `OperationOutcome`. La respuesta de éxito incluye `_diagnosticOs: { orderId, patientId, studyIds }`.
- **Anulación:** reenviar el mismo `ServiceRequest` con `status: "revoked"` (o `entered-in-error`) cancela la orden en Diagnostic OS si aún no se completó.
- `GET /api/fhir/tenants/{tenantId}/metadata` (con la clave) sirve para comprobar que la clave funciona.

## 2. Configuración paso a paso

1. **Desplegar** el backend nuevo (el *build* ejecuta `prisma db push`, que solo **agrega** columnas; no borra datos).
2. **En Clinic-OS:** crear una integración con el scope `system/DiagnosticReport.write`. Anotar `client_id` y `client_secret` (se muestran una sola vez).
3. **En Diagnostic OS** (panel de administrador → *Integraciones* → centro → *Configurar*): URL base (`https://<clinic-os>/api/fhir`), autenticación *OAuth2*, `client_id`, `client_secret` → *Guardar conexión* → **Probar conexión** (debe mostrar ✓ en los tres pasos).
4. **Generar clave de entrada** (misma pantalla) y entregársela a Clinic-OS junto con la URL de `ServiceRequest` que muestra el panel.
5. **Prueba de punta a punta:** enviar una orden desde Clinic-OS → aparece en Diagnostic OS (con su estudio) → cargar resultado → validar → publicar → en *Registro de mensajes* debe aparecer *Confirmado (ACK)* y el resultado en Clinic-OS.
6. Informes publicados **antes** de conectar: botón *Enviar este informe a …* en la vista previa de integración.

## 3. Variables de entorno nuevas (Diagnostic OS)

| Variable | Para qué |
|---|---|
| `INTEGRATION_ENC_KEY` | Cifra en la base el `client_secret` y las claves de API. Si falta, se deriva de `JWT_SECRET`. Recomendado definirla aparte. |
| `INTEGRATION_PAYLOAD_PROFILE` | `clinicos` (predeterminado con OAuth2) o `full` (FHIR completo con Observations y adjuntos). |

## 4. Qué cambió en Diagnostic OS (resumen)

- **Envío saliente:** OAuth2 `client_credentials` con token en caché y renovación; informe en formato Clinic-OS; reintentos persistentes con espera creciente (sobreviven a reinicios); botón *Reintentar*; `Idempotency-Key`; omisión explícita cuando no hay a qué orden adjuntar.
- **Entrada:** las órdenes recibidas ahora **crean sus estudios** (antes quedaban sin estudio y no se podía emitir informe); emparejamiento de estudios por catálogo; idempotencia; Bundles; anulación; paciente por cédula aunque no sea el primer identificador.
- **Bug corregido — el envío nunca se disparaba:** la interfaz publica guardando el estado completo (`PUT /api/state`), no llamando a `/reports/:id/publish`, así que el conector jamás se ejecutaba. Ahora se envía cuando un informe pasa a *publicado* (o sube de versión republicado) por cualquiera de las dos vías.
- **Bug corregido — mensaje falso:** al publicar, la interfaz inventaba un mensaje "enviado/ACK" aunque no se enviara nada. Ahora el estado es el real.
- **Bug corregido — pérdida de datos:** un guardado automático con una pestaña desactualizada **borraba** las órdenes/pacientes que Clinic-OS acababa de enviar (y las reservas en línea). Ahora el servidor protege lo creado después de que el navegador cargó sus datos, y la app se refresca sola cada 30 s si no hay cambios pendientes.
- **Seguridad:** secretos cifrados en la base y nunca devueltos al navegador ni a la auditoría; la clave de entrada se guarda solo como hash; comparación en tiempo constante; URLs validadas (https obligatorio en producción); errores `async` ya no tumban el servidor.
