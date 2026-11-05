// Biblioteca · lector de recetas (Cloudflare Worker)
//
// Lee la página de una receta que has encontrado en internet y la devuelve ya ordenada
// en el formato de las fichas de la Biblioteca (título, raciones, tiempos, ingredientes, pasos…).
//
//   GET  /estado   → { ok, ia }            (sin sesión: solo dice si la IA está configurada)
//   POST /extraer  { url, ia }             → { receta, metodo, aviso }  |  { receta:null, texto, meta }
//   POST /texto    { texto }               → { receta, metodo:"ia" }   (solo con IA)
//
// Solo atiende a cuentas de la lista "permitidos" de Firestore: la app manda el token de la sesión
// y aquí se comprueba preguntando a Firestore con ese mismo token.
//
// La IA es opcional. Si añades el secreto ANTHROPIC_API_KEY en Cloudflare, el lector:
//   · entiende páginas que no traen los datos de receta ordenados,
//   · interpreta el texto que pegues a mano,
//   · traduce al español y pasa tazas, onzas y °F a gramos, mililitros y °C.

const PROYECTO = "biblioteca-cocina";
const ORIGENES = [
  "https://biblioteca-cocina.web.app",
  "https://biblioteca-cocina.firebaseapp.com",
  "https://localhost",            // app Android (Capacitor)
  "capacitor://localhost",
];
const CATEGORIAS = ["entrantes","ensaladas","sopas","arroces","pasta","legumbres","verduras","huevos",
                    "pescados","carnes","aves","salsas","guarniciones","masas","postres","otros"];
const ALERGENOS = ["gluten","crustaceos","huevos","pescado","cacahuetes","soja","lacteos","cascara",
                   "apio","mostaza","sesamo","sulfitos","altramuces","moluscos"];
const MAX_HTML = 4 * 1024 * 1024;
const MAX_TEXTO_IA = 16000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

class Aviso extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = cabecerasCors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
    const ruta = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (ruta === "/estado" || ruta === "/") return json({ ok: true, ia: !!env.ANTHROPIC_API_KEY });
      if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
      await comprobarUsuario(req);
      const body = await req.json().catch(() => ({}));
      if (ruta === "/extraer") return json(await extraer(body, env));
      if (ruta === "/texto") return json(await desdeTexto(body, env));
      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      const status = e instanceof Aviso ? e.status : 500;
      return json({ error: e instanceof Aviso ? e.message : "Error inesperado del lector." }, status);
    }
  },
};

function cabecerasCors(origin) {
  const ok = ORIGENES.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const h = { "Vary": "Origin" };
  if (ok) Object.assign(h, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  return h;
}

/* ==================== ACCESO ==================== */
const CACHE_ACCESO = new Map();   // token → caduca (ms)
async function comprobarUsuario(req) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Aviso("Falta la sesión. Vuelve a entrar en la Biblioteca.", 401);
  const hit = CACHE_ACCESO.get(token);
  if (hit && hit > Date.now()) return;

  let p;
  try { p = JSON.parse(atobUrl(token.split(".")[1])); } catch { throw new Aviso("Sesión no válida.", 401); }
  if (p.aud !== PROYECTO || !p.sub) throw new Aviso("Sesión no válida.", 401);
  if (p.exp * 1000 < Date.now()) throw new Aviso("La sesión ha caducado. Cierra y vuelve a abrir la Biblioteca.", 401);

  // Firestore comprueba la firma del token y aplica las reglas: solo responde 200 si estás en "permitidos".
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents/permitidos/${encodeURIComponent(p.sub)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 200) {
    if (CACHE_ACCESO.size > 200) CACHE_ACCESO.clear();
    CACHE_ACCESO.set(token, Math.min(p.exp * 1000, Date.now() + 10 * 60 * 1000));
    return;
  }
  if (r.status === 401) throw new Aviso("La sesión ha caducado. Vuelve a entrar.", 401);
  throw new Aviso("Esta cuenta no está autorizada.", 403);
}
function atobUrl(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

/* ==================== LEER UNA PÁGINA ==================== */
async function extraer({ url, ia = "auto" } = {}, env) {
  const destino = validarUrl(url);
  const html = await descargar(destino);
  const meta = leerMeta(html, destino);

  let receta = desdeJsonLd(html) || desdeMicrodatos(html);
  let metodo = receta ? "datos" : null;
  let aviso = "";
  const hayIa = !!env.ANTHROPIC_API_KEY && ia !== "nunca";

  if (receta) {
    completar(receta, meta);
    const enEspanol = esEspanol(meta.idioma, receta);
    if (hayIa && (ia === "siempre" || !enEspanol)) {
      try {
        receta = { ...receta, ...(await conIA(env, JSON.stringify(compacta(receta)), "estructurada")) };
        metodo = "datos+ia";
      } catch (e) { aviso = "No se pudo repasar con IA; se muestra tal cual viene en la web."; }
    } else if (!enEspanol) {
      aviso = "La receta no está en español. Revísala antes de guardarla.";
    }
    return { receta, metodo, aviso, meta };
  }

  const texto = htmlATexto(html);
  if (hayIa) {
    const r = await conIA(env, `Título de la página: ${meta.titulo}\n\n${texto.slice(0, MAX_TEXTO_IA)}`, "texto");
    receta = { ...r, url: destino.href, sitio: meta.sitio, imagen: meta.imagen, autor: "" };
    return { receta, metodo: "ia", aviso: "La web no traía los datos ordenados: la ha interpretado la IA. Repásala.", meta };
  }
  // Sin IA: devolvemos el texto y la app lo interpreta como si lo hubieras pegado.
  return { receta: null, texto: texto.slice(0, 40000), meta };
}

async function desdeTexto({ texto } = {}, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Aviso("La IA no está configurada en el lector.", 400);
  texto = String(texto || "").trim();
  if (texto.length < 30) throw new Aviso("Pega el texto completo de la receta.");
  return { receta: await conIA(env, texto.slice(0, MAX_TEXTO_IA), "texto"), metodo: "ia" };
}

function validarUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Aviso("Ese enlace no es válido."); }
  if (!/^https?:$/.test(u.protocol)) throw new Aviso("El enlace tiene que empezar por http o https.");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":"))
    throw new Aviso("Ese enlace no es una web pública.");
  if (u.port && !["80", "443"].includes(u.port)) throw new Aviso("Ese enlace no es una web pública.");
  return u;
}

async function descargar(u) {
  let res;
  try {
    res = await fetch(u.href, {
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9,en;q=0.6" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Aviso("No se pudo abrir la página (no responde o tarda demasiado).", 502);
  }
  if ([401, 403, 429, 503].includes(res.status))
    throw new Aviso("Esa web no deja leer sus páginas desde fuera. Copia el texto de la receta y usa la pestaña «Texto».", 502);
  if (res.status === 404) throw new Aviso("La página no existe (error 404). Revisa el enlace.", 502);
  if (!res.ok) throw new Aviso(`La web ha respondido con un error (${res.status}).`, 502);
  const tipo = res.headers.get("Content-Type") || "";
  if (tipo && !/html|xml|text\/plain/i.test(tipo)) throw new Aviso("Ese enlace no es una página web (¿es un PDF o una imagen?). Súbelo con «Añadir».");

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf.byteLength > MAX_HTML ? buf.slice(0, MAX_HTML) : buf);
  let charset = (tipo.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!charset) {
    const cabeza = String.fromCharCode(...bytes.subarray(0, 4096));
    charset = (cabeza.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  charset = (charset || "utf-8").toLowerCase();
  if (charset === "utf-8" || charset === "utf8") return new TextDecoder("utf-8").decode(bytes);
  try { return new TextDecoder(charset).decode(bytes); }
  catch {
    // Webs antiguas en ISO-8859-1 / Windows-1252: cada byte es un carácter
    if (/8859|1252|latin/.test(charset)) { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; }
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function leerMeta(html, u) {
  const m = (re) => decodificar((html.match(re) || [])[1] || "").trim();
  const prop = (p) => m(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, "i"))
                   || m(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, "i"));
  let imagen = prop("og:image") || prop("twitter:image");
  try { if (imagen) imagen = new URL(imagen, u).href; } catch { imagen = ""; }
  return {
    titulo: prop("og:title") || m(/<title[^>]*>([\s\S]*?)<\/title>/i),
    descripcion: prop("og:description") || prop("description"),
    imagen,
    sitio: prop("og:site_name") || u.hostname.replace(/^www\./, ""),
    idioma: (m(/<html[^>]*\slang=["']?([\w-]+)/i) || prop("og:locale") || "").toLowerCase(),
    url: u.href,
  };
}

/* ==================== DATOS ESTRUCTURADOS (JSON-LD) ==================== */
function desdeJsonLd(html) {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let txt = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/^\s*\/\/.*$/gm, "");
    let data;
    try { data = JSON.parse(txt); }
    catch {
      try { data = JSON.parse(txt.replace(/[\u0000-\u001F]+/g, " ").replace(/,\s*([}\]])/g, "$1")); } catch { continue; }
    }
    const r = buscarReceta(data, 0);
    if (r) return normalizar(r);
  }
  return null;
}
function esTipo(o, t) {
  const tipo = o && o["@type"];
  return Array.isArray(tipo) ? tipo.some(x => String(x).toLowerCase() === t) : String(tipo || "").toLowerCase() === t;
}
function buscarReceta(o, depth) {
  if (!o || typeof o !== "object" || depth > 8) return null;
  if (Array.isArray(o)) { for (const x of o) { const r = buscarReceta(x, depth + 1); if (r) return r; } return null; }
  if (esTipo(o, "recipe") && (o.recipeIngredient || o.ingredients || o.recipeInstructions)) return o;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "hasPart", "about", "item"]) {
    const r = buscarReceta(o[k], depth + 1); if (r) return r;
  }
  return null;
}

function normalizar(r) {
  const txt = v => limpiar(Array.isArray(v) ? v[0] : (v && typeof v === "object" ? (v.name || v["@value"] || "") : v));
  return {
    titulo: txt(r.name || r.headline),
    descripcion: recortar(limpiar(r.description), 400),
    imagen: elegirImagen(r.image),
    autor: listaNombres(r.author).join(", "),
    raciones: rendimiento(r.recipeYield || r.yield),
    tiempoPrep: duracion(r.prepTime),
    tiempoCoc: duracion(r.cookTime),
    tiempoTotal: duracion(r.totalTime),
    ingredientes: ingredientesDe(r.recipeIngredient || r.ingredients),
    pasos: pasosDe(r.recipeInstructions),
    categoriaWeb: aLista(r.recipeCategory).concat(aLista(r.recipeCuisine)).map(limpiar).filter(Boolean),
    etiquetas: etiquetasDe(r.keywords),
    idioma: String(r.inLanguage || "").toLowerCase(),
  };
}
function aLista(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(aLista);
  if (typeof v === "object") return [v.name || v["@value"] || ""];
  return [String(v)];
}
function listaNombres(v) { return aLista(v).map(limpiar).filter(Boolean).slice(0, 3); }
function elegirImagen(v) {
  if (!v) return "";
  if (Array.isArray(v)) { for (const x of v) { const s = elegirImagen(x); if (s) return s; } return ""; }
  if (typeof v === "object") return elegirImagen(v.url || v.contentUrl || v["@id"]);
  const s = String(v).trim();
  return /^https?:\/\//i.test(s) ? s : "";
}
function rendimiento(v) {
  const l = aLista(v).map(limpiar).filter(Boolean);
  if (!l.length) return "";
  const conTexto = l.find(x => /[a-záéíóúñ]/i.test(x));
  const s = conTexto || l[0];
  return /^\d+([.,]\d+)?$/.test(s) ? `${s} raciones` : s;
}
function duracion(v) {
  const s = String(aLista(v)[0] || "").trim();
  if (!s) return "";
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+)S)?)?$/i);
  if (!m) return /\d/.test(s) && s.length < 40 ? s : "";
  let min = Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) + (+m[4] || 0) / 60);
  if (!min) return "";
  const h = Math.floor(min / 60), mm = min % 60;
  return h ? (mm ? `${h} h ${mm} min` : `${h} h`) : `${mm} min`;
}
function ingredientesDe(v) {
  let l = aLista(v);
  if (l.length === 1 && /\n/.test(l[0])) l = l[0].split(/\n+/);
  return l.map(limpiar).map(s => s.replace(/^[-•·*▪◦]\s*/, "")).filter(Boolean).slice(0, 120);
}
function pasosDe(v) {
  const out = [];
  const walk = (x) => {
    if (x == null) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") {
      if (esTipo(x, "howtosection") || (x.itemListElement && !x.text)) {
        if (x.name) out.push("## " + limpiar(x.name));
        walk(x.itemListElement || x.steps);
        return;
      }
      walk(x.text || x.name || x.description || "");
      return;
    }
    const s = String(x);
    // Un texto con HTML o saltos de línea puede traer varios pasos dentro
    const partes = /<(li|p|br)\b/i.test(s) ? htmlATexto(s).split("\n") : s.split(/\n+/);
    for (const p of partes) {
      const t = limpiar(p).replace(/^(paso\s*\d+\s*[:.)-]?|\d{1,2}\s*[.)-]\s+)/i, "").trim();
      if (t) out.push(t);
    }
  };
  walk(v);
  return out.slice(0, 80);
}
function etiquetasDe(v) {
  const l = aLista(v).flatMap(s => String(s).split(",")).map(s => limpiar(s).toLowerCase()).filter(s => s && s.length <= 30);
  return [...new Set(l)].slice(0, 8);
}

/* ==================== MICRODATOS (webs antiguas) ==================== */
function desdeMicrodatos(html) {
  const ini = html.search(/itemtype=["']https?:\/\/schema\.org\/Recipe["']/i);
  if (ini < 0) return null;
  const zona = html.slice(ini, ini + 400000);
  const props = (nombres) => {
    const re = new RegExp(`<(\\w+)([^>]*\\sitemprop=["'](?:${nombres})["'][^>]*)>`, "gi");
    const out = []; let m;
    while ((m = re.exec(zona))) {
      const attrs = m[2];
      const content = (attrs.match(/\scontent=["']([^"']*)["']/i) || attrs.match(/\sdatetime=["']([^"']*)["']/i) || [])[1];
      if (content != null) { out.push(content); continue; }
      if (/^(meta|link|img)$/i.test(m[1])) continue;
      out.push(bloque(zona, m.index, m[1]));
    }
    return out;
  };
  const ingredientes = props("recipeIngredient|ingredients").map(h => limpiar(htmlATexto(h).replace(/\n/g, " "))).filter(Boolean);
  if (!ingredientes.length) return null;
  const pasos = props("recipeInstructions").flatMap(h => pasosDe(/<(li|p|br)\b/i.test(h) ? h : limpiar(h)));
  return {
    titulo: limpiar(htmlATexto(props("name")[0] || "")),
    descripcion: recortar(limpiar(htmlATexto(props("description")[0] || "")), 400),
    imagen: "",
    autor: limpiar(htmlATexto(props("author")[0] || "")),
    raciones: rendimiento(htmlATexto(props("recipeYield")[0] || "")),
    tiempoPrep: duracion(props("prepTime")[0]),
    tiempoCoc: duracion(props("cookTime")[0]),
    tiempoTotal: duracion(props("totalTime")[0]),
    ingredientes,
    pasos,
    categoriaWeb: props("recipeCategory").map(h => limpiar(htmlATexto(h))).filter(Boolean),
    etiquetas: [],
    idioma: "",
  };
}
// Devuelve el HTML interior de la etiqueta que empieza en "pos", respetando etiquetas anidadas del mismo nombre.
function bloque(html, pos, tag) {
  const abre = html.indexOf(">", pos) + 1;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = abre;
  let nivel = 1, m;
  while ((m = re.exec(html))) {
    nivel += m[1] ? -1 : 1;
    if (nivel === 0) return html.slice(abre, m.index);
    if (re.lastIndex - abre > 200000) break;
  }
  return html.slice(abre, abre + 5000);
}

/* ==================== TEXTO ==================== */
function htmlATexto(html) {
  let h = String(html || "");
  const principal = (h.match(/<article\b[\s\S]*<\/article>/i) || h.match(/<main\b[\s\S]*<\/main>/i) || [])[0];
  if (principal && principal.length > 800) h = principal;
  h = h.replace(/<!--[\s\S]*?-->/g, " ")
       .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|select|button|template)\b[\s\S]*?<\/\1>/gi, " ")
       .replace(/<br\s*\/?>/gi, "\n")
       .replace(/<li\b[^>]*>/gi, "\n")
       .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|dd|dt|blockquote|figcaption|table)>/gi, "\n")
       .replace(/<(h[1-6])\b[^>]*>/gi, "\n")
       .replace(/<[^>]+>/g, " ");
  const lineas = decodificar(h).split("\n").map(s => s.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);
  const out = [];
  for (const l of lineas) if (out[out.length - 1] !== l) out.push(l);
  return out.join("\n");
}
const ENT = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'", nbsp:" ", aacute:"á", eacute:"é", iacute:"í", oacute:"ó", uacute:"ú",
  Aacute:"Á", Eacute:"É", Iacute:"Í", Oacute:"Ó", Uacute:"Ú", ntilde:"ñ", Ntilde:"Ñ", uuml:"ü", Uuml:"Ü", iexcl:"¡", iquest:"¿",
  ordf:"ª", ordm:"º", deg:"°", frac12:"½", frac14:"¼", frac34:"¾", hellip:"…", ndash:"–", mdash:"—", laquo:"«", raquo:"»",
  rsquo:"’", lsquo:"‘", ldquo:"“", rdquo:"”", middot:"·", times:"×", ccedil:"ç", agrave:"à", egrave:"è", ograve:"ò", euro:"€", reg:"®", copy:"©", trade:"™" };
function decodificar(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return all; }
    }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? all;
  });
}
function limpiar(s) {
  if (s == null) return "";
  let t = String(s);
  if (/[<&]/.test(t)) t = decodificar(t.replace(/<[^>]+>/g, " "));
  if (/&[a-z#0-9]+;/i.test(t)) t = decodificar(t);   // doble codificación, frecuente en WordPress
  return t.replace(/\s+/g, " ").trim();
}
function recortar(s, n) { return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; }

function completar(r, meta) {
  r.titulo = r.titulo || meta.titulo;
  r.descripcion = r.descripcion || recortar(limpiar(meta.descripcion), 400);
  r.imagen = r.imagen || meta.imagen;
  r.sitio = meta.sitio;
  r.url = meta.url;
  if (r.imagen) { try { r.imagen = new URL(r.imagen, meta.url).href; } catch { r.imagen = ""; } }
}
function esEspanol(idiomaPagina, r) {
  const idioma = r.idioma || idiomaPagina;
  if (idioma) return idioma.startsWith("es");
  const t = (r.ingredientes.join(" ") + " " + r.pasos.join(" ")).toLowerCase();
  const es = (t.match(/\b(de|con|y|el|la|los|las|para|una?|cucharadas?)\b/g) || []).length;
  const en = (t.match(/\b(of|with|and|the|cups?|tablespoons?|teaspoons?|into|until)\b/g) || []).length;
  return es >= en;
}
function compacta(r) {
  return { titulo: r.titulo, descripcion: r.descripcion, raciones: r.raciones, tiempoPrep: r.tiempoPrep,
           tiempoCoc: r.tiempoCoc, tiempoTotal: r.tiempoTotal, ingredientes: r.ingredientes, pasos: r.pasos,
           categoriaWeb: r.categoriaWeb, etiquetas: r.etiquetas };
}

/* ==================== IA (opcional) ==================== */
const SISTEMA = `Eres el jefe de cocina de un hotel y pasas recetas encontradas en internet al formato de las fichas de tu biblioteca profesional. Respondes SOLO con un objeto JSON válido, sin texto antes ni después y sin bloques de código.`;

function instrucciones(modo) {
  return `${modo === "estructurada" ? "Te paso una receta ya extraída de una web, en JSON." : "Te paso el texto de una página web o un texto copiado que contiene una receta."}
Devuélvela con este formato exacto:
{
  "titulo": "nombre del plato, sin el nombre de la web ni coletillas",
  "descripcion": "una o dos frases objetivas sobre el plato (sin publicidad ni anécdotas)",
  "categoria": "una de: ${CATEGORIAS.join(", ")}",
  "raciones": "p. ej. 4 raciones, o 1 molde de 22 cm",
  "tiempoPrep": "p. ej. 20 min, o \\"\\" si no consta",
  "tiempoCoc": "",
  "tiempoTotal": "",
  "ingredientes": ["200 g de harina de trigo", "2 huevos L"],
  "pasos": ["Tamizar la harina…", "…"],
  "alergenos": ["solo ids de esta lista que estén presentes: ${ALERGENOS.join(", ")}"],
  "etiquetas": ["máximo 6, en minúscula, útiles para buscar: técnica, temporada, cocina…"]
}
Normas:
- Español de España y vocabulario profesional de cocina.
- Sistema métrico: g, kg, ml, l, °C. Convierte tazas, cucharadas americanas, onzas, libras y °F con equivalencias razonables (en ingredientes secos, a gramos).
- Respeta las cantidades. No inventes ingredientes, pasos ni tiempos: si un dato no consta, déjalo en "".
- Un paso por elemento, en infinitivo, sin numerar. Si la receta tiene partes (masa, relleno, salsa…), mete una línea "## Nombre de la parte" antes de sus ingredientes y antes de sus pasos.
- Quita publicidad, comentarios, historias personales y llamadas a suscribirse.
- Si el texto no contiene una receta, responde {"error":"no es una receta"}.`;
}

async function conIA(env, contenido, modo) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.MODELO || "claude-haiku-5-5",
        max_tokens: 4000,
        system: SISTEMA,
        messages: [{ role: "user", content: `${instrucciones(modo)}\n\n---\n${contenido}` }],
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch { throw new Aviso("La IA no ha respondido a tiempo. Prueba otra vez.", 504); }
  if (res.status === 401) throw new Aviso("La clave de la IA no es válida. Revísala en Cloudflare.", 502);
  if (res.status === 429 || res.status === 529) throw new Aviso("La IA está saturada. Prueba en un minuto.", 503);
  if (!res.ok) throw new Aviso(`La IA ha devuelto un error (${res.status}).`, 502);
  const data = await res.json();
  const txt = (data.content || []).map(c => c.text || "").join("");
  let o;
  try { o = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); }
  catch { throw new Aviso("La IA no ha devuelto una receta legible. Prueba otra vez.", 502); }
  if (o.error) throw new Aviso("En ese texto no se ha encontrado ninguna receta.");
  const lista = v => (Array.isArray(v) ? v : []).map(x => limpiar(x)).filter(Boolean);
  const r = {
    titulo: limpiar(o.titulo), descripcion: recortar(limpiar(o.descripcion), 400),
    raciones: limpiar(o.raciones), tiempoPrep: limpiar(o.tiempoPrep), tiempoCoc: limpiar(o.tiempoCoc), tiempoTotal: limpiar(o.tiempoTotal),
    ingredientes: lista(o.ingredientes).slice(0, 120), pasos: lista(o.pasos).slice(0, 80),
    alergenos: lista(o.alergenos).filter(a => ALERGENOS.includes(a)),
    etiquetas: lista(o.etiquetas).map(s => s.toLowerCase()).slice(0, 6),
  };
  if (CATEGORIAS.includes(o.categoria)) r.categoria = o.categoria;
  if (!r.ingredientes.length) throw new Aviso("No se han encontrado ingredientes en ese texto.");
  return r;
}
