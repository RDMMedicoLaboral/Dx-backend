# Integración Diagnostic OS ⇄ Clinic-OS

Este documento es el **contrato** entre las dos aplicaciones. Está escrito para quien mantiene Clinic-OS y para quien configura la conexión. Todo lo que aparece aquí está cubierto por pruebas automáticas (`npm test`) que corren Diagnostic OS contra un "Clinic-OS de mentira" con este mismo contrato.

## El modelo: una conexión por cada pareja laboratorio ⇄ clínica

La conexión **no es entre dos plataformas**: es entre **una clínica concreta y un laboratorio concreto** (por ejemplo, *Clínica RDM* en Clinic-OS con *Laboratorio Narcisa de Jesús* en Diagnostic OS). Un laboratorio puede atender a **varias clínicas** a la vez, y cada una es una **conexión** distinta:

- **Cada conexión tiene su propia clave de entrada.** La clave identifica a la clínica: Diagnostic OS sabe con certeza quién envía cada orden, sin fiarse de lo que diga el contenido.
- **Cada orden queda marcada con su conexión** (y con el nombre de la clínica, visible para el personal del laboratorio).
- **El número de orden solo es único dentro de una clínica.** La orden `5` de la clínica A y la orden `5` de la clínica B son órdenes distintas; Diagnostic OS nunca las confunde ni las deduplica entre sí.
- **El resultado vuelve ÚNICAMENTE a la conexión de la orden que lo originó**, a la dirección y con las credenciales de *esa* clínica. Hay además una comprobación final que bloquea cualquier envío hacia una conexión distinta de la de su orden.
- **Aislamiento de datos:** una clínica solo puede leer los informes de **sus** órdenes y los pacientes que **ella** envió, y solo ve **sus propios** identificadores del paciente (nunca los de otras clínicas). Su clave no sirve en el laboratorio de otro.
- Las órdenes creadas dentro del laboratorio (sin clínica) no se envían a nadie.

```
 Clínica RDM ── (1) orden ──▶ Laboratorio Narcisa de Jesús      POST {URL del laboratorio}/ServiceRequest   (X-API-Key de RDM)
 Clínica RDM ◀── (2) informe ── Laboratorio Narcisa de Jesús    POST {URL de RDM}/DiagnosticReport          (OAuth2 de RDM)
```

La **URL del laboratorio** es la misma para todas sus clínicas: `https://<servidor de Diagnostic OS>/api/fhir/tenants/<id del laboratorio>`. Lo que distingue a cada clínica es **su clave**. Tanto la URL como el id del laboratorio aparecen en el panel de Diagnostic OS (*Integraciones → Datos del laboratorio para conectarse*) con botón de copiar.

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
  | Orden original | `basedOn[0].identifier` → **exactamente el `system` y el `value` que Clinic-OS envió** en `ServiceRequest.identifier[0]` (Diagnostic OS los devuelve idénticos, sea cual sea su formato; si Clinic-OS no envió `system`, se usa `urn:clinicos:lab-order`) |
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
- **URL:** `https://<servidor de Diagnostic OS>/api/fhir/tenants/<id del laboratorio>/ServiceRequest`.
- **Autenticación:** encabezado `X-API-Key: <clave>` (también acepta `Authorization: Bearer <clave>`). La clave es **de la conexión de esa clínica con ese laboratorio**: la genera el administrador en *Integraciones → (la clínica) → Generar clave* y se muestra **una sola vez**. Una clave solo sirve en la URL de su propio laboratorio.
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
- `GET /api/fhir/tenants/{tenantId}/metadata` (con la clave) sirve para **probar la conexión**: responde un `CapabilityStatement` con `publisher` = nombre del laboratorio e `implementation.description` = `"<laboratorio> · conexión \"<clínica>\""`, de modo que Clinic-OS puede mostrar *"Conectado con Laboratorio Narcisa de Jesús"*. Si la dirección no es la API de Diagnostic OS (por ejemplo, es la de su página web) la respuesta no será este JSON: tratarlo como "dirección incorrecta".
- **Consultas (opcionales):** `GET .../DiagnosticReport/{id}` y `GET .../Patient/{id}`, limitadas a lo que **esa** clínica envió.
- **Conexión desactivada:** responde `403` ("Esta conexión está desactivada por el laboratorio").

## 2. Configuración paso a paso (ejemplo: Clínica RDM con Laboratorio Narcisa de Jesús)

**En Diagnostic OS** (panel de administrador → *Integraciones* → elegir el laboratorio):
1. Pulsar **Nueva conexión** y escribir el nombre de la clínica (*Clínica RDM*). Se crea una por cada clínica.
2. Dentro de la conexión, **1. Recibir órdenes → Generar clave**. El panel muestra (una sola vez) la **clave** y la **dirección del laboratorio**: entregar ambas a la clínica.
3. **2. Devolver los resultados** → *Configurar destino*: elegir *Clinic-OS*, pegar la dirección FHIR de la clínica (`https://<clinic-os>/api/fhir`), el `client_id` y el `client_secret` que la clínica creó para este laboratorio (scope `system/DiagnosticReport.write`) → *Guardar* → **Probar conexión** (✓ en los tres pasos).

**En Clinic-OS:** pegar la dirección del laboratorio y la clave en la configuración de ese laboratorio y pulsar *Probar conexión* (verá el nombre del laboratorio). Crear el cliente OAuth `system/DiagnosticReport.write` para ese laboratorio y entregar su `client_id`/`client_secret` al administrador de Diagnostic OS.

**Prueba de punta a punta:** enviar una orden desde Clinic-OS → aparece en Diagnostic OS marcada con *Clínica RDM* → cargar resultado → validar → publicar → en *Registro de mensajes* aparece *Confirmado (ACK)* y el resultado llega a Clinic-OS, solo a RDM.

Para sumar otra clínica al mismo laboratorio: repetir con una **nueva conexión**; la anterior no se toca. Informes publicados **antes** de conectar: botón *Enviar este informe a …* en la vista previa de integración.

### Qué cubre y qué no (de este lado)
- **Un laboratorio con varias clínicas:** sí (una conexión por clínica).
- **Una clínica con varios laboratorios:** del lado de Diagnostic OS cada laboratorio es un centro independiente con su propia dirección y su propia clave para esa clínica, así que funciona. Lo que debe resolver **Clinic-OS** es guardar una conexión por laboratorio y elegir a cuál va cada orden. Al recibir un informe, Clinic-OS sabe de qué laboratorio viene por el cliente OAuth con el que llega.

## 3. Variables de entorno nuevas (Diagnostic OS)

| Variable | Para qué |
|---|---|
| `INTEGRATION_ENC_KEY` | Cifra en la base el `client_secret` y las claves de API. Si falta, se deriva de `JWT_SECRET`. Recomendado definirla aparte. |
| `INTEGRATION_PAYLOAD_PROFILE` | `clinicos` (predeterminado con OAuth2) o `full` (FHIR completo con Observations y adjuntos). |

## 4. Qué cambió en Diagnostic OS (resumen)

- **Conexiones por clínica (nuevo):** el conector único por centro se reemplazó por conexiones independientes (clave de entrada, destino de retorno y credenciales propios por clínica). Los centros configurados con la versión anterior se **migran solos** al arrancar: su clave sigue valiendo, sus órdenes y pacientes quedan marcados con la conexión migrada y los secretos antiguos se borran del centro.
- **Sin mezclas entre clínicas:** idempotencia por (laboratorio, conexión, número de orden); identificador de la orden devuelto tal cual; retorno solo a la conexión de la orden; consultas e identificadores de paciente aislados por clínica; índice único en la base contra envíos simultáneos duplicados.
- **Envío saliente:** OAuth2 `client_credentials` con token en caché y renovación; informe en formato Clinic-OS; reintentos persistentes con espera creciente (sobreviven a reinicios); botón *Reintentar*; `Idempotency-Key`; omisión explícita cuando no hay a qué orden adjuntar.
- **Entrada:** las órdenes recibidas ahora **crean sus estudios** (antes quedaban sin estudio y no se podía emitir informe); emparejamiento de estudios por catálogo; idempotencia; Bundles; anulación; paciente por cédula aunque no sea el primer identificador.
- **Bug corregido — el envío nunca se disparaba:** la interfaz publica guardando el estado completo (`PUT /api/state`), no llamando a `/reports/:id/publish`, así que el conector jamás se ejecutaba. Ahora se envía cuando un informe pasa a *publicado* (o sube de versión republicado) por cualquiera de las dos vías.
- **Bug corregido — mensaje falso:** al publicar, la interfaz inventaba un mensaje "enviado/ACK" aunque no se enviara nada. Ahora el estado es el real.
- **Bug corregido — pérdida de datos:** un guardado automático con una pestaña desactualizada **borraba** las órdenes/pacientes que Clinic-OS acababa de enviar (y las reservas en línea). Ahora el servidor protege lo creado después de que el navegador cargó sus datos, y la app se refresca sola cada 30 s si no hay cambios pendientes.
- **Seguridad:** secretos cifrados en la base y nunca devueltos al navegador ni a la auditoría; la clave de entrada se guarda solo como hash; comparación en tiempo constante; URLs validadas (https obligatorio en producción); errores `async` ya no tumban el servidor.
