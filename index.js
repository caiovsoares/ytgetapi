const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const app = express();
const port = 3007;
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// Adicione isso no início do arquivo, após as importações
if (!fs.existsSync(path.join(__dirname, 'output'))) {
  fs.mkdirSync(path.join(__dirname, 'output'));
}

// Adicione isso após as importações
function cleanOutputDirectory() {
  const outputDir = path.join(__dirname, 'output');
  fs.readdir(outputDir, (err, files) => {
    if (err) return;
    for (const file of files) {
      fs.unlink(path.join(outputDir, file), (err) => {
        if (err) console.error('Erro ao limpar arquivo temporário:', err);
      });
    }
  });
}

// Limpar diretório a cada hora
setInterval(cleanOutputDirectory, 3600000);
// Limpar ao iniciar o servidor
cleanOutputDirectory();

// // Configurar caminho do FFmpeg (adicione após as importações)
// ffmpeg.setFfmpegPath('C:\\ffmpeg\\bin\\ffmpeg.exe'); // Ajuste o caminho conforme sua instalação

// Função para obter os melhores formatos de vídeo e áudio
async function getBestFormats(url) {
  const info = await ytdl.getInfo(url);
  const formats = info.formats;

  // Primeiro, tenta encontrar um formato com vídeo 1080p e áudio juntos
  let videoFormat = formats.find(
    (f) => f.hasVideo && f.hasAudio && f.height === 1080
  );

  // Se não encontrar 1080p com áudio, procura o melhor formato de vídeo (1080p sem áudio)
  if (!videoFormat) {
    videoFormat = formats
      .filter((f) => f.hasVideo && f.height === 1080)
      .sort((a, b) => b.bitrate - a.bitrate)[0];
  }

  // Se ainda não encontrou, pega o melhor formato de vídeo disponível
  if (!videoFormat) {
    videoFormat = formats
      .filter((f) => f.hasVideo)
      .sort((a, b) => b.height - a.height)[0];
  }

  // Pega o formato de áudio original
  const audioFormat = formats
    .filter(
      (f) =>
        f.hasAudio &&
        !f.hasVideo &&
        f.audioQuality === 'AUDIO_QUALITY_MEDIUM' && // Qualidade média geralmente é o áudio original
        f.container === 'mp4' // Preferimos container mp4 para melhor compatibilidade
    )
    .sort((a, b) => b.audioBitrate - a.audioBitrate)[0];

  // Se não encontrar o formato específico, tenta qualquer formato de áudio
  if (!audioFormat) {
    const fallbackAudioFormat = formats
      .filter((f) => f.hasAudio && !f.hasVideo)
      .sort((a, b) => b.audioBitrate - a.audioBitrate)[0];

    return {
      videoFormat,
      audioFormat: fallbackAudioFormat,
      needsAudioMerge: videoFormat && !videoFormat.hasAudio,
    };
  }

  return {
    videoFormat,
    audioFormat,
    needsAudioMerge: videoFormat && !videoFormat.hasAudio,
  };
}

// Função para salvar stream em arquivo
function saveStreamToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(filePath);
    stream.pipe(fileStream);
    fileStream.on('finish', () => resolve(filePath));
    fileStream.on('error', reject);
  });
}

// Função para criar o vídeo final combinando vídeo e áudio
async function combineVideoAndAudio(videoStream, audioStream, outputPath) {
  try {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const tempVideoPath = path.join(
      __dirname,
      'output',
      `temp_video_${uniqueSuffix}.mp4`
    );
    const tempAudioPath = path.join(
      __dirname,
      'output',
      `temp_audio_${uniqueSuffix}.mp4`
    );

    await saveStreamToFile(videoStream, tempVideoPath);
    await saveStreamToFile(audioStream, tempAudioPath);

    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(tempVideoPath)
        .input(tempAudioPath)
        .audioCodec('copy') // Usar 'copy' para preservar o áudio original
        .videoCodec('copy') // Usar 'copy' para preservar o vídeo original
        .output(outputPath)
        .on('end', () => {
          fs.unlinkSync(tempVideoPath);
          fs.unlinkSync(tempAudioPath);
          resolve(outputPath);
        })
        .on('error', (err) => {
          try {
            if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
            if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
          } catch (e) {
            console.error('Erro ao limpar arquivos temporários:', e);
          }
          reject(err);
        })
        .run();
    });
  } catch (error) {
    throw new Error(`Erro ao combinar vídeo e áudio: ${error.message}`);
  }
}

// Rota para download do vídeo
app.get('/download', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('A URL do vídeo do YouTube é necessária');
  }

  try {
    // Valida a URL
    if (!ytdl.validateURL(url)) {
      return res.status(400).send('URL inválida do YouTube');
    }

    // Obter os melhores formatos
    const { videoFormat, audioFormat, needsAudioMerge } = await getBestFormats(
      url
    );

    if (!videoFormat) {
      return res
        .status(404)
        .send('Não foi possível encontrar um formato de vídeo adequado.');
    }

    // Se o vídeo já tem áudio, baixa diretamente
    if (!needsAudioMerge) {
      // Configura os cabeçalhos para o download do arquivo
      res.header('Content-Disposition', 'attachment; filename="video.mp4"');
      res.header('Content-Type', 'video/mp4');

      let contentLength = videoFormat.contentLength;
      if (!contentLength && videoFormat.url) {
        // Se não houver contentLength, realiza uma requisição HEAD para obtê-lo
        const reqModule = videoFormat.url.startsWith('https') ? https : http;
        try {
          contentLength = await new Promise((resolve, reject) => {
            reqModule
              .get(videoFormat.url, { method: 'HEAD' }, (headRes) => {
                resolve(headRes.headers['content-length']);
              })
              .on('error', reject);
          });
        } catch (err) {
          console.error('Erro ao obter Content-Length:', err);
        }
      }
      if (contentLength) {
        res.header('Content-Length', contentLength);
      }

      const videoStream = ytdl(url, { format: videoFormat });
      videoStream.pipe(res);
      return;
    }

    // Caso contrário, baixa vídeo e áudio separadamente e combina
    const videoStream = ytdl(url, { format: videoFormat });
    const audioStream = ytdl(url, { format: audioFormat });

    // Nome do arquivo de saída
    const outputPath = path.join(__dirname, 'output', 'video.mp4');

    // Criar o arquivo final combinando o vídeo e o áudio
    const filePath = await combineVideoAndAudio(
      videoStream,
      audioStream,
      outputPath
    );

    // Configura os cabeçalhos para o download do arquivo
    res.header('Content-Disposition', 'attachment; filename="video.mp4"');
    res.header('Content-Type', 'video/mp4');

    // Adicionar o cabeçalho Content-Length para o arquivo combinado
    const stats = fs.statSync(filePath);
    res.header('Content-Length', stats.size);

    // Enviar o arquivo combinado como resposta
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    // Limpeza após o envio do arquivo
    fileStream.on('end', () => {
      fs.unlinkSync(filePath); // Deleta o arquivo temporário
    });
  } catch (error) {
    console.error('Erro ao baixar e combinar o vídeo:', error);
    res.status(500).send('Erro ao tentar baixar o vídeo');
  }
});

// Iniciar o servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
