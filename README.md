# Diagnostic OS — Backend

API real (Node.js + Express) sobre **PostgreSQL en Neon** (datos estructurados)
y **Cloudinary** (imágenes/videos/PDFs), pensada para desplegarse en **Render**.
Refleja el mismo modelo de datos que ya tenías en `src/data/models.js` del
frontend, así que conectar el frontend no debería requerir rediseñar ninguna
pantalla — solo cambiar de dónde vienen los datos.

## Arquitectura

| Pieza | Servicio | Qué guarda |
|---|---|---|
| API (este código) | Render | Lógica, autenticación, reglas de negocio |
| Base de datos | Neon (Postgres) | Pacientes, órdenes, estudios, resultados, usuarios, auditoría — todo lo estructurado |
| Archivos | Cloudinary | Fotos, videos, PDFs, radiografías escaneadas |

---

## PASO A PASO — ya subiste el repo a GitHub, ahora esto:

### 1. Crear la base de datos en Neon

1. Ve a [neon.tech](https://neon.tech) y crea una cuenta gratis.
2. **Create a project** → cualquier nombre (ej. `diagnostic-os`) → región cercana a ti.
3. Neon te muestra un **Connection string** parecido a:
   ```
   postgresql://usuario:contraseña@ep-xxxx.us-east-2.aws.neon.tech/diagnostic_os?sslmode=require
   ```
   **Cópialo** — lo vas a necesitar en el paso 3. (Puedes verlo de nuevo en Neon → tu proyecto → "Connection Details" cuando quieras.)

### 2. Crear la cuenta de Cloudinary

1. Ve a [cloudinary.com](https://cloudinary.com) y crea una cuenta gratis.
2. En el **Dashboard**, copia estos tres valores (están ahí apenas entras):
   - `Cloud name`
   - `API Key`
   - `API Secret` (haz clic en el ojito para verlo)

### 3. Crear el servicio en Render

1. Ve a [render.com](https://render.com) → **New → Web Service**.
2. Conecta tu cuenta de GitHub y elige el repositorio (`Dx-backend` o el que hayas usado).
3. **Root Directory:** déjalo **vacío**. Solo se pone algo ahí si el backend está dentro de una subcarpeta de tu repo; si subiste `prisma/`, `src/`, `package.json` directo a la raíz del repo (como en `Dx-backend`), este campo debe quedar en blanco — si pusiste `backend` y te salió el error *"Root directory 'backend' does not exist"*, entra a **Settings → Build → Root Directory → Edit** y bórralo.
4. Configura:
   - **Build Command:** `npm install && npx prisma generate && npx prisma db push`
   - **Start Command:** `npm run start`
   - **Instance Type:** Free

   > Usamos `prisma db push` en vez de `prisma migrate deploy` porque este último necesita archivos de "migración" que se generan corriendo Prisma con internet completo (algo que no pude hacer yo al armar esto). `db push` crea/actualiza las tablas directamente a partir de `schema.prisma`, sin ese paso extra — perfecto para esta etapa. Si más adelante quieres un historial de migraciones prolijo, se puede migrar a `migrate deploy` corriendo `npx prisma migrate dev` una vez desde tu computadora con internet.
5. Antes de darle a "Create", baja a **Environment Variables** y agrega:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | el connection string de Neon (paso 1) |
   | `JWT_SECRET` | clic en "Generate" |
   | `CORS_ORIGINS` | la URL raíz de tu GitHub Pages, ej. `https://rdmmedicolaboral.github.io` (sin `/` ni subcarpetas al final) |
   | `CLOUDINARY_CLOUD_NAME` | del paso 2 (ojo con el nombre exacto de la variable) |
   | `CLOUDINARY_API_KEY` | del paso 2 |
   | `CLOUDINARY_API_SECRET` | del paso 2 |
   | `ADMIN_EMAIL` | el correo con el que entrarás al panel de administrador (paso 4) |
   | `ADMIN_PASSWORD` | una contraseña larga y única (mínimo 12 caracteres) |
   | `INTEGRATION_ENC_KEY` | clic en "Generate" — cifra los secretos de las integraciones |
   | `NODE_ENV` | `production` |
6. Clic en **Create Web Service**. Render instala, compila y crea las tablas automáticamente (el build command incluye `prisma migrate deploy`). Tarda 2-5 minutos — puedes ver el progreso en la pestaña **Logs**.

### 4. Crear el administrador de plataforma

No hay datos ni cuentas de demostración: el sistema arranca **vacío**. El administrador se crea solo,
al arrancar el servidor, con las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD` del paso anterior
(en los Logs verás `Administrador de plataforma creado`). La contraseña no se guarda en ningún
archivo ni se muestra por HTTP.

- **Cambiar la contraseña del administrador:** cambia el valor de `ADMIN_PASSWORD` en Render y reinicia el servicio.
- **Desde tu computadora:** `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin`.
- Después entra a `admin.html` con ese correo y crea los centros y sus usuarios desde el panel.

> **Si vienes de una versión anterior** que sembraba cuentas de demostración (`soporte@diagnosticos.app`,
> `*.demo`): esas contraseñas eran públicas. Al definir `ADMIN_EMAIL` y `ADMIN_PASSWORD` y reiniciar, el
> servidor deja **inutilizables** las cuentas que todavía las usen; restablece su contraseña desde el panel
> (Centros y usuarios), o elimínalas si eran de prueba. El panel muestra un aviso rojo mientras quede alguna.

### 5. Probar que funciona

Render te da una URL como `https://diagnostic-os-backend.onrender.com`. Prueba en el navegador o con curl:
```bash
curl https://diagnostic-os-backend.onrender.com/health
# → {"ok":true}
```

Y probar el login del administrador (con el correo y la contraseña que definiste en `ADMIN_EMAIL` / `ADMIN_PASSWORD`):
```bash
curl -X POST https://diagnostic-os-backend.onrender.com/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{"email":"TU_ADMIN_EMAIL","password":"TU_ADMIN_PASSWORD"}'
```
Si te devuelve un `token`, el backend ya está vivo y conectado a Neon.

> **Nota sobre el plan gratuito de Render:** el servicio se "duerme" tras 15 min sin uso y la primera petición después de eso tarda unos 30-50 segundos en responder mientras despierta. Es normal, no es un error.

---

## Endpoints principales

- `POST /api/auth/login` — dueños de centro y su personal.
- `POST /api/auth/admin-login` — solo el administrador de la plataforma.
- `/api/admin/*` — todo lo del superadmin (crear centros, usuarios, conectores). Protegido: solo `platform_admin`.
- `/api/patients`, `/api/orders`, `/api/studies`, `/api/specimens`, `/api/results`, `/api/reports`, `/api/catalog`, `/api/appointments`, `/api/audit` — el día a día de un centro. Protegido y siempre filtrado por el centro de quien inició sesión.
- `/api/fhir/*` — el puente FHIR R4 con el HCE (ver siguiente sección).
- `/api/public/*` — lo que usa la página de reservas, sin login.
- `/api/uploads` — subir/listar/borrar archivos (fotos, PDFs, videos) vinculados a un paciente/estudio/informe. Van a Cloudinary; en la base de datos solo se guarda la URL y los metadatos.

## Conectar con el HCE (FHIR R4)

Un laboratorio puede trabajar con **varias clínicas a la vez**. Desde el panel de superadmin
(`admin.html` → pestaña "Integraciones" → elegir el laboratorio) se crea **una conexión por cada clínica**; cada
una tiene su propia clave de entrada y su propio destino de retorno, las órdenes quedan marcadas con su clínica y
los resultados vuelven solo a ella. El panel muestra el id y la dirección del laboratorio (para pegarlos en la
clínica) con botón de copiar. El detalle completo del contrato está en
[`docs/INTEGRACION_CLINIC-OS.md`](docs/INTEGRACION_CLINIC-OS.md).

**HCE → Diagnostic OS (entrada de órdenes):**
```
POST /api/fhir/tenants/{tenantId}/ServiceRequest
Headers: X-API-Key: <la clave de ESA clínica, generada en su conexión>
Body: un recurso FHIR ServiceRequest, con el Patient embebido en "contained"
```

**Diagnostic OS → HCE (salida de informes):**
Al publicar un informe, si su orden vino de una clínica conectada, se envía a la dirección de ESA conexión
automáticamente:
```
POST {baseUrl}/DiagnosticReport   (Authorization: Bearer <token OAuth2 o clave de API>)
```

**Consultas (pull) del HCE:**
```
GET /api/fhir/tenants/{tenantId}/DiagnosticReport/{reportId}
GET /api/fhir/tenants/{tenantId}/Patient/{patientId}
Headers: X-API-Key: <la clave configurada>
```

> Si tu HCE no habla FHIR sino HL7v2 o una API propietaria, dímelo y armamos
> un adaptador que traduzca hacia este mismo formato interno.

## Desarrollo local

```bash
cd backend
cp .env.example .env       # pega tu DATABASE_URL de Neon y tus claves de Cloudinary
npm install
npx prisma migrate dev --name init
npm run create-admin       # con ADMIN_EMAIL y ADMIN_PASSWORD en el .env
npm run dev
```
