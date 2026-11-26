# 📦 Mi Stock

PWA (aplicación web instalable) para llevar el **stock de productos con fotos y precios**, que funciona **sin conexión a internet**.

## Funciones

- Alta / edición / eliminación de productos con **foto** (cámara o galería), nombre, categoría, talla (S, M, L, XL...), precio de costo, precio de venta, cantidad, stock mínimo y notas.
- **Duplicar producto** con un toque (ideal para cargar la misma prenda en otra talla) y **compartir** ficha con foto por WhatsApp.
- Botones **＋ / −** para ajustar el stock rápido (tocando el número se escribe la cantidad exacta).
- **Venta rápida (🛒) y Catastro de ventas**: armá el carrito, calculá descuento y vuelto, registrá el medio de pago y descontá todo del stock automáticamente.
- **Catastro**: historial completo de todo lo vendido con filtros por período (hoy, 7 días, mes, todo), medio de pago, cálculo de ganancia real y exportación a CSV.
- Búsqueda, filtro por categoría, **filtro por talla**, filtro de **stock bajo/agotado** y orden por nombre, precio o cantidad.
- **Ajuste masivo de precios (%)** por categoría o en todo el catálogo con redondeo automático.
- **100 % offline**: los datos, fotos y ventas se guardan en el propio dispositivo (IndexedDB). Las fotos se comprimen automáticamente.
- **Respaldo** completo en un archivo `.json` (incluye fotos y catastro de ventas) e **importación** del respaldo, más aviso si hace más de 7 días sin respaldar.
- Exportación a **planilla CSV** (stock y catastro de ventas para Excel / Google Sheets).
- Selección de moneda (ARS, USD, UYU, CLP, etc.). Modo oscuro automático.

## Publicar en GitHub Pages

1. Subí este repositorio a GitHub.
2. En el repo: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, rama `main`, carpeta `/ (root)` → **Save**.
3. En 1–2 minutos queda disponible en `https://<tu-usuario>.github.io/<nombre-del-repo>/`.

## Instalar en el teléfono

1. Abrí la dirección de GitHub Pages **una vez con internet**.
2. **Android (Chrome):** menú ⋮ de la app → *Instalar app* (o menú del navegador → *Instalar aplicación*).
   **iPhone (Safari):** botón *Compartir* → *Agregar a inicio*.
3. Listo: desde ahora se abre desde el ícono y funciona sin internet.

> ⚠️ Los datos quedan **sólo en ese dispositivo/navegador**. Si borrás los datos del navegador o desinstalás la app se pierden: descargá un **respaldo** cada tanto (menú ⋮ → *Descargar respaldo*).

## Actualizar la app

- Desde la app: en el menú **⋮ (Opciones)** tocá **"🔄 Buscar actualización"**. Si hay cambios en GitHub se descargan solos y se recarga la app.
- También se verifica automáticamente cada vez que abrís la app con conexión a internet.
- **Tus productos, fotos y precios nunca se pierden al actualizar** (están guardados de forma segura en la base de datos local del dispositivo).

## Probar en la PC

```bash
python -m http.server 8080
```
y abrir http://localhost:8080

