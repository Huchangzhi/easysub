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
      ],
    }),
    new HtmlPlugin({
      template: 'src/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
    }),
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
