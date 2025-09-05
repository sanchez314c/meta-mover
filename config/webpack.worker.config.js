const path = require('path');

module.exports = {
  target: 'node',
  entry: './src/main/workers/ProcessingWorker.ts',
  output: {
    path: path.resolve(__dirname, '../dist/workers'),
    filename: 'ProcessingWorker.js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@main': path.resolve(__dirname, '../src/main'),
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  externals: {
    'sharp': 'commonjs sharp',
    'sqlite3': 'commonjs sqlite3',
    'better-sqlite3': 'commonjs better-sqlite3',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  optimization: {
    minimize: false,
  },
};
