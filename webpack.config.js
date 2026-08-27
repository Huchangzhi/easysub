const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    background: './src/background.ts',
    content: './src/content.ts',
    popup: './src/popup.ts',
    offscreen: './src/offscreen.ts',
    'translation-worker': './src/translation-worker.ts',
    permission: './src/permission.ts',
    i18n: './src/i18n.ts', // ponytail: 纯导出模块做 entry 生成孤立 i18n.js，不被任何页面引用
  },
  module: {
    rules: [
      { test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      // 坑：@huggingface/transformers 的 exports 指向预打包的 transformers.web.js，
      // 它是"webpack 包套 webpack 包"，内层 publicPath 会烘焙成绝对路径，扩展里必坏。
      // 改打包其 src 源码，让 onnxruntime-web 成为真正的依赖被 webpack 内联（无外部加载）。
      '@huggingface/transformers': path.resolve(__dirname, 'node_modules/@huggingface/transformers/src/transformers.js'),
    },
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'public', to: '.' },
        { from: 'manifest.json', to: '.' },
        { from: '_locales', to: '_locales' },
        // 离线翻译运行时：onnxruntime-web 的 wasm 二进制，由翻译 worker 从 ort-wasm/ 拉取
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm*.wasm', to: 'ort-wasm/[name][ext]' },
        // onnxruntime-web 会动态 import() 这个 ESM 运行时，URL 按 worker 自身地址解析到扩展根
        { from: 'node_modules/onnxruntime-web/dist/ort.bundle.min.mjs', to: 'ort.bundle.min.mjs' },
      ],
    }),
    new HtmlPlugin({
      template: 'src/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
    }),
    // pitfall: HtmlPlugin 会自动注入 <script defer src="offscreen.js">，
    // 所以 template 里不能手动写 <script src="offscreen.js">，否则同一文件执行两遍
    new HtmlPlugin({
      template: 'src/offscreen.html',
      filename: 'offscreen.html',
      chunks: ['offscreen'],
    }),
    new HtmlPlugin({
      template: 'src/permission.html',
      filename: 'permission.html',
      chunks: ['permission'],
    }),
    // ponytail: transformers src/env.js 用 import.meta，webpack 5.87+ 把它替换成
    // { url, webpack:5, main: __webpack_module__===... }，而经典 worker（非 ESM 输出）
    // 不定义 __webpack_module__ 直接 ReferenceError。注入一个变量即可；
    // 其 url 被烘焙成 file:///E:/... 只喂 cacheDir/localModelPath 默认值，
    // worker 里已用显式 wasmPaths/localModelPath/useBrowserCache 覆盖，无害。
    new webpack.BannerPlugin({
      banner: 'var __webpack_module__;',
      raw: true,
      entryOnly: true,
      test: /translation-worker/,
    }),
  ],
};
