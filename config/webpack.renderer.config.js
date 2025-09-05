const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  
  return {
    target: 'electron-renderer',
    entry: './src/renderer/index.tsx',
    output: {
      path: path.resolve(__dirname, '../dist/renderer'),
      filename: 'index.js',
      clean: true,
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.jsx'],
      alias: {
        '@renderer': path.resolve(__dirname, '../src/renderer'),
        '@shared': path.resolve(__dirname, '../src/shared'),
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/i,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.(png|jpe?g|gif|svg)$/i,
          use: [
            {
              loader: 'file-loader',
              options: {
                outputPath: 'assets/images/',
              },
            },
          ],
        },
        {
          test: /\.(woff|woff2|eot|ttf|otf)$/i,
          use: [
            {
              loader: 'file-loader',
              options: {
                outputPath: 'assets/fonts/',
              },
            },
          ],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/renderer/index.html',
        inject: true,
      }),
    ],
    devServer: {
      static: {
        directory: path.join(__dirname, '../dist/renderer'),
      },
      compress: true,
      port: 58594,
      hot: true,
      open: false,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    },
    optimization: {
      minimize: isProduction,
    },
    devtool: isProduction ? 'source-map' : 'inline-source-map',
  };
};