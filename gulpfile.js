import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import process from 'node:process';

import gulp from 'gulp';
import plumber from 'gulp-plumber';
import htmlmin from 'gulp-htmlmin';
import * as dartSass from 'sass';
import gulpSass from 'gulp-sass';
import postcss from 'gulp-postcss';
import postUrl from 'postcss-url';
import lightningcss from 'postcss-lightningcss';
import { build } from 'esbuild';
import browserslistToEsbuild from 'browserslist-to-esbuild';
import sharp from 'gulp-sharp-responsive';
import svgo from 'gulp-svgmin';
import { stacksvg } from 'gulp-stacksvg';
import server from 'browser-sync';
import bemlinter from 'gulp-html-bemlinter';

const { src, dest, watch, series, parallel } = gulp;
const sass = gulpSass(dartSass);
const PATH_TO_SOURCE = './source/';
const PATH_TO_DIST = './build/';
const PATH_TO_RAW = './raw/';
const PATHS_TO_STATIC = [
  `${PATH_TO_SOURCE}fonts/**/*.{woff2,woff}`,
  `${PATH_TO_SOURCE}*.ico`,
  `${PATH_TO_SOURCE}*.webmanifest`,
  `${PATH_TO_SOURCE}favicons/**/*.{png,svg}`,
  `${PATH_TO_SOURCE}vendor/**/*`,
  `${PATH_TO_SOURCE}images/**/*`,
  `!${PATH_TO_SOURCE}**/README.md`,
];
const isDevelopment = () => process.env.NODE_ENV !== 'production';

// Настройки сборки скриптов (esbuild)
const SCRIPTS_SPLITTING = false; // true — общий код и import() уходят в build/scripts/chunks/ (нужен type="module")
const SCRIPTS_ALIAS = {}; // например { '@': './source/scripts' } для import from '@/modules/x.js'

export function processMarkup () {
  return src(`${PATH_TO_SOURCE}**/*.html`)
    .pipe(plumber())
    .pipe(htmlmin({
      collapseWhitespace: !isDevelopment(),
      removeComments: !isDevelopment(),
    }))
    .pipe(dest(PATH_TO_DIST))
    .pipe(server.stream());
}

export function lintBem () {
  return src(`${PATH_TO_SOURCE}**/*.html`)
    .pipe(bemlinter());
}

export function processStyles () {
  return src(`${PATH_TO_SOURCE}styles/*.scss`, { sourcemaps: isDevelopment() })
    .pipe(plumber())
    .pipe(sass().on('error', sass.logError))
    .pipe(postcss([
      postUrl([
        {
          filter: '**/*',
          assetsPath: '../',
        },
        {
          filter: '**/icons/**/*.svg',
          url: (asset) => asset.url.replace(
            /icons\/(.+?)\.svg$/,
            (match, p1) => `icons/stack.svg#${p1.replace(/\//g, '_')}`
          ),
          multi: true,
        },
      ]),
      lightningcss({
        lightningcssOptions: {
          minify: !isDevelopment(),
        },
      })
    ]))
    .pipe(dest(`${PATH_TO_DIST}styles`, { sourcemaps: isDevelopment() }))
    .pipe(server.stream());
}

export async function processScripts () {
  const scriptsDir = `${PATH_TO_SOURCE}scripts`;

  if (!existsSync(scriptsDir)) {
    return;
  }

  // точки входа — js-файлы верхнего уровня, остальное подтягивается импортами
  const entryPoints = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => `${scriptsDir}/${name}`);

  if (entryPoints.length === 0) {
    return;
  }

  try {
    await build({
      entryPoints,
      outdir: `${PATH_TO_DIST}scripts`,
      bundle: true,
      format: 'esm',
      splitting: SCRIPTS_SPLITTING,
      chunkNames: 'chunks/[name]-[hash]',
      alias: SCRIPTS_ALIAS,
      define: {
        'process.env.NODE_ENV': JSON.stringify(isDevelopment() ? 'development' : 'production'),
      },
      platform: 'browser',
      minify: !isDevelopment(),
      sourcemap: isDevelopment(),
      target: browserslistToEsbuild(),
      logLevel: 'warning',
    });
  } catch (error) {
    // esbuild уже вывел ошибку; в dev не роняем watcher, в build — падаем
    if (!isDevelopment()) {
      throw error;
    }
  }
}

export function optimizeRaster () {
  const RAW_DENSITY = 2;
  const TARGET_FORMATS = [undefined, 'webp']; // undefined — initial format: jpg or png

  function createOptionsFormat() {
    const formats = [];

    for (const format of TARGET_FORMATS) {
      for (let density = RAW_DENSITY; density > 0; density--) {
        formats.push(
          {
            format,
            rename: { suffix: `@${density}x` },
            width: ({ width }) => Math.ceil(width * density / RAW_DENSITY),
            jpegOptions: { progressive: true },
          },
        );
      }
    }

    return { formats };
  }

  return src(`${PATH_TO_RAW}images/**/*.{png,jpg,jpeg}`)
    .pipe(sharp(createOptionsFormat()))
    .pipe(dest(`${PATH_TO_SOURCE}images`));
}

export function optimizeVector () {
  return src([`${PATH_TO_RAW}**/*.svg`])
    .pipe(svgo())
    .pipe(dest(PATH_TO_SOURCE));
}

export function createStack () {
  return src(`${PATH_TO_SOURCE}icons/**/*.svg`)
    .pipe(stacksvg())
    .pipe(dest(`${PATH_TO_DIST}icons`));
}

export function copyStatic () {
  return src(PATHS_TO_STATIC, { base: PATH_TO_SOURCE })
    .pipe(dest(PATH_TO_DIST));
}

export function startServer () {
  const serveStatic = PATHS_TO_STATIC
    .filter((path) => path.startsWith('!') === false)
    .map((path) => {
      const dir = path.replace(/(\/\*\*\/.*$)|\/$/, '');
      const route = dir.replace(PATH_TO_SOURCE, '/');

      return { route, dir };
    });

  server.init({
    server: {
      baseDir: PATH_TO_DIST
    },
    serveStatic,
    cors: true,
    notify: false,
    ui: false,
  }, (err, bs) => {
    bs.addMiddleware('*', (req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.write(readFileSync(`${PATH_TO_DIST}404.html`));
      res.end();
    });
  });

  watch(`${PATH_TO_SOURCE}**/*.{html,njk}`, series(processMarkup));
  watch(`${PATH_TO_SOURCE}styles/**/*.scss`, series(processStyles));
  watch(`${PATH_TO_SOURCE}scripts/**/*.js`, series(processScripts, reloadServer));
  watch(`${PATH_TO_SOURCE}icons/**/*.svg`, series(createStack, reloadServer));
  watch(PATHS_TO_STATIC, series(reloadServer));
}

function reloadServer (done) {
  server.reload();
  done();
}

export function removeBuild (done) {
  rmSync(PATH_TO_DIST, {
    force: true,
    recursive: true,
  });
  done();
}

export function buildProd (done) {
  process.env.NODE_ENV = 'production';
  series(
    removeBuild,
    parallel(
      processMarkup,
      processStyles,
      processScripts,
      createStack,
      copyStatic,
    ),
  )(done);
}

export function runDev (done) {
  series(
    removeBuild,
    parallel(
      processMarkup,
      processStyles,
      processScripts,
      createStack,
    ),
    startServer,
  )(done);
}
