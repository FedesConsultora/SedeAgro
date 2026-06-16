# SedeAgro

---

## 📖 Resumen

**SedeAgro** es una plataforma SaaS para el sector agrícola, construida sobre la robusta arquitectura de **Axios** y adaptada para un modelo multi‑tenant en América Latina. Permite gestionar organizaciones, establecimientos, lotes, campañas, monitoreos de campo, órdenes de trabajo, imágenes satelitales e integraciones con ERP, maquinaria y sistemas de sensores.

---

## 🎯 Visión y Propósito

- **Objetivo:** Entregar un hub digital premium, de extremo a extremo, que transforme datos dispersos del campo en decisiones operativas auditables.
- **Usuarios objetivo:** Agrónomos, contratistas, consultores, técnicos de campo, productores y proveedores de servicios que necesitan coordinación en tiempo real, trazabilidad y capacidad offline.
- **Principio central:** SaaS multi‑tenant con un modelo de dominio centrado en GIS, escalable y seguro.

---

## 🛠️ Módulos Funcionales Clave

| Módulo | Descripción | Prioridad |
|--------|-------------|----------|
| **Base Organizacional** | Usuarios, roles, permisos, equipos, aislamiento multi‑tenant | Alta |
| **Core GIS** | Establecimientos, lotes, polígonos, superficies, consultas espaciales (PostGIS) | Alta |
| **Campañas y Cultivos** | Planificación temporal, tipos de cultivo, variedades, calendarios agronómicos | Alta |
| **Monitoreo de Campo** | Captura offline (fotos, audio, notas, way‑points) | Alta |
| **Órdenes de Trabajo** | Creación, asignación, flujo de estados, aprobaciones, reportes | Alta |
| **Panel Analítico** | KPIs, visualizaciones de mapas, semáforos, líneas de tiempo | Alta |
| **Imágenes Satelitales** | Capas NDVI/GNDVI/RGB, historial de imágenes | Media‑Alta |
| **Lluvias / Riego** | Entradas manuales, alimentación de sensores, superposiciones | Media |
| **Integraciones** | ERP, APIs de maquinaria, plataformas de sensores, soporte ISOBUS | Media |
| **Reportes Automáticos** | Exportación PDF/Excel, envío programado por correo | Alta |

---

## 🏗️ Stack Tecnológico

| Capa | Tecnología |
|------|------------|
| **Frontend (Web)** | React + Next.js (SSR opcional) |
| **App Móvil** | React Native **o** Flutter (offline‑first, cámara, GPS) |
| **Backend** | Node.js con NestJS (modular, TypeScript) |
| **Base de Datos** | PostgreSQL + PostGIS |
| **Cache / Cola** | Redis + workers en background |
| **Almacenamiento** | Bucket compatible S3 (fotos, audio, documentos) |
| **Mapas / GIS** | Mapbox o OpenLayers con teselas personalizadas |
| **Imágenes Satelitales** | Sentinel‑2 / Landsat (open) + proveedores premium |
| **Observabilidad** | Logs estructurados, métricas, alertas (Grafana, Loki) |

---

## 📂 Estructura del Proyecto (inicial)

```
SedeAgro/
├─ README.md                 # 📄 Este archivo
├─ .git/                     # Repositorio Git (ya inicializado)
├─ package.json              # Dependencias Node/NestJS
├─ tsconfig.json             # Configuración TypeScript
├─ src/                      # Código backend (módulos NestJS)
│   ├─ app.module.ts
│   └─ ...
├─ web/                      # Frontend (Next.js)
│   ├─ pages/
│   └─ components/
├─ mobile/                   # Esqueleto React Native / Flutter
└─ infra/                    # Terraform / Docker Compose (futuro)
```

---

## 🚀 Cómo Empezar (Desarrollo)

1. **Instalar dependencias**:
   ```bash
   cd /Users/enzopinotti/Desktop/SedeAgro
   npm install   # instala dependencias del backend y frontend (workspaces si se configuran)
   ```
2. **Configurar la base de datos** (PostgreSQL + PostGIS). Ejemplo usando Docker:
   ```bash
   docker run -d --name pg-sedeagro \
     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=sedeagro \
     -p 5432:5432 postgis/postgis:13-master
   ```
   Luego crea un archivo `.env` con la cadena de conexión:
   ```env
   DATABASE_URL=postgresql://admin:secret@localhost:5432/sedeagro
   ```
3. **Ejecutar el backend** en modo watch:
   ```bash
   npm run start:dev   # asume script definido en package.json
   ```
4. **Ejecutar el frontend web**:
   ```bash
   cd web
   npm run dev
   ```
5. **(Opcional) Iniciar la app móvil** – sigue la guía en `mobile/README.md` para React Native o Flutter.

---

## 🛠️ Construcción para Producción

- **Backend:** `npm run build && npm run start:prod`
- **Web:** `cd web && npm run build && npm start`
- **Docker:** Los archivos de compose estarán bajo `infra/` para despliegues reproducibles.

---

## 🤝 Contribuir

1. Haz fork del repositorio.
2. Crea una rama de feature (`git checkout -b feat/nueva‑funcionalidad`).
3. Sigue el **estilo de código** definido por ESLint/Prettier (configurado en el repo).
4. Escribe pruebas unitarias/integración para la nueva funcionalidad.
5. Abre un Pull Request con una descripción clara del cambio.

---

## 📄 Licencia

Este proyecto está bajo la **licencia MIT** – ver el archivo `LICENSE` para más detalles.

---

*Elaborado el 16 de junio de 2026.*
