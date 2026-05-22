import { PicGo } from 'picgo'
import type { IPicGo } from 'picgo'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { AppConfig, ConfigEnum } from './index.enum'
import { UploaderConfig } from './config'
import { posix } from 'path'
import { verifyConfig } from './utils'
import type { FileType } from './types'

const notify = (ctx: IPicGo, {
  title, body, text
}: {
  title: string
  body: string
  text?: string
}): void => {
  ctx.emit('notification', {
    title,
    body,
    text
  })
}

const createS3Client = (config: Record<string, string>): S3Client => {
  return new S3Client({
    region: 'auto',
    endpoint: config[ConfigEnum.ENDPOINT],
    credentials: {
      accessKeyId: config[ConfigEnum.ACCESS_KEY],
      secretAccessKey: config[ConfigEnum.SECRET_ACCESS]
    }
  })
}

export = (_ctx: PicGo) => {
  const register = (ctx: IPicGo) => {
    ctx.helper.uploader.register(AppConfig.NAME, {
      async handle (ctx) {
        const { default: mime } = await import('mime')

        const config = ctx.getConfig<Record<string, string>>('picBed.cloudflare-r2')
        const storageKey = config[ConfigEnum.SUB_FOLDER] ?? '/'
        const errMeg = verifyConfig(config)
        if (errMeg) {
          notify(ctx, {
            title: '配置错误',
            body: errMeg
          })
          return ctx.output
        }
        const S3 = createS3Client(config)

        for (const imageItem of ctx.output) {
          const { fileName: filename, buffer, extname } = imageItem
          if (!filename) { continue }
          if ((/(\\|\/|:)/ig).test(filename)) {
            notify(ctx, {
              title: '上传文件名错误',
              body: '请勿使用:/\\此类具有歧义的符号'
            })
            continue
          }

          try {
            let uri = posix.join(storageKey, filename)
            ctx.log.info('uri', uri)
            if (uri.startsWith('/')) {
              uri = uri.slice(1)
            }
            const objRes = await S3.send(new PutObjectCommand({
              Bucket: config[ConfigEnum.BUCKET_NAME],
              Body: buffer,
              Key: uri,
              ContentType: mime.getType(extname ?? '') ?? 'application/octet-stream'
            }))
            ctx.log.info('objRes', String(objRes.$metadata.httpStatusCode))
            if (objRes.$metadata.httpStatusCode !== 200) {
              throw new Error('上传到存储桶失败，请检查原因')
            }
            const url = new URL(uri, config.domain)
            imageItem.imgUrl = url.href
            imageItem.url = url.href
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.log.error('uploader error', message)
            if (error instanceof Error && error.name.includes('NoSuchBucket')) {
              notify(ctx, { title: '上传错误', body: '对应的存储桶不存在' })
            } else if (error instanceof Error && error.name.includes('InvalidBucketName')) {
              notify(ctx, { title: '上传错误', body: '存储桶名称至少三个字符' })
            } else {
              notify(ctx, { title: '上传错误', body: message })
            }
          }
        }
        return ctx.output
      },
      config: (_ctx) => UploaderConfig
    })

    ctx.on('remove', async (files: FileType[], _guiApi: any) => {
      const config = ctx.getConfig<Record<string, string>>('picBed.cloudflare-r2')
      const S3 = createS3Client(config)

      for (const file of files) {
        const { type, imgUrl, fileName } = file
        ctx.log.info('file', JSON.stringify({ type, fileName }))
        if (type !== AppConfig.NAME) { continue }

        const url = new URL(imgUrl)
        let pathname = url.pathname
        if (pathname.startsWith('/')) {
          pathname = pathname.slice(1)
        }

        ctx.log.info('remove file', pathname)
        try {
          const delRes = await S3.send(new DeleteObjectCommand({
            Bucket: config[ConfigEnum.BUCKET_NAME],
            Key: pathname
          }))
          ctx.log.info('remove success', String(delRes.$metadata.httpStatusCode))
          notify(ctx, {
            title: '删除成功',
            body: `cloudflare-r2中成功删除${fileName}文件`
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.log.info('remove error', message)
          notify(ctx, {
            title: '删除失败',
            body: message
          })
        }
      }
    })
  }
  return {
    register,
    uploader: AppConfig.NAME
  }
}
