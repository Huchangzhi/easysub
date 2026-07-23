const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    background: './src/background.ts',
    content: './src/content.ts',
    popup: './src/popup.ts',
    offscreen: './src/offscreen.ts',
    permission: './src/permission.ts',
    i18n: './src/i18n.ts',
  },
  module: {
    rules: [
      { test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
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
  ],
};
