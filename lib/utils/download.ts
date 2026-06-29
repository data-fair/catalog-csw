import fs from 'fs'
import axios from '@data-fair/lib-node/axios.js'
import type { AxiosRequestConfig } from 'axios'

/**
 * Downloads a file from a URL to a local path.
 * @param url - The source URL to download from.
 * @param destPath - The local file system path where the file will be saved.
 * @param label - A label used for logging (the resource ID).
 * @param log - The logger object
 * @param axiosConfig - Optional Axios configuration
 * @returns A promise that resolves to the destination path upon success.
 */
export async function downloadFileWithProgress (
  url: string,
  destPath: string,
  label: string,
  log: any,
  axiosConfig: AxiosRequestConfig = {}
): Promise<string> {
  // Create a write stream to save the file to the disk
  const writer = fs.createWriteStream(destPath)

  try {
    // Make the HTTP GET request
    const response = await axios.get(url, {
      ...axiosConfig,
      responseType: 'stream',
    })

    // Attempt to get the total file size from headers for progress calculation
    const contentLength = response.headers['content-length'] as string | undefined
    const totalLength = contentLength ? parseInt(contentLength, 10) : undefined

    // Initialize the logging task
    await log.task(`download ${label}`, 'Downloading...', totalLength)

    let downloadedBytes = 0
    let lastLogged = Date.now()
    const logInterval = 500 // Update progress log every 500ms to avoid spamming the console

    // Listen to the data chunk event to update progress
    response.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length
      const now = Date.now()
      // Only update the log if the interval has passed
      if (now - lastLogged > logInterval) {
        lastLogged = now
        log.progress(`download ${label}`, downloadedBytes, totalLength)
      }
    })

    // Pipe the download stream directly into the file writer
    response.data.pipe(writer)

    // Return a promise that resolves when writing is finished or rejects on error
    return await new Promise<string>((resolve, reject) => {
      // Success: The file has been fully written
      writer.on('finish', async () => {
        // Ensure the progress bar shows 100% (or the final byte count) at the end
        await log.progress(`download ${label}`, downloadedBytes, downloadedBytes)
        resolve(destPath)
      })

      // Error handling helper
      const handleError = (err: any) => {
        // Close the stream explicitly
        writer.close()
        // Delete the partial file to avoid corruption
        fs.unlink(destPath, () => {})
        reject(err)
      }

      // Listen for errors on both the file writer and the download stream
      writer.on('error', handleError)
      response.data.on('error', handleError)
    })
  } catch (err: any) {
    if (err.response) {
      const status = err.response.status
      if (status >= 400 && status < 500) {
        let msg = `Client error (${status})`
        switch (status) {
          case 400:
            msg = 'Invalid request (400). The parameters sent may be incorrect.'
            break
          case 401:
            msg = 'Access denied (401). Check the username and password in the configuration.'
            break
          case 403:
            msg = 'Access forbidden (403). You do not have the necessary rights to access this file.'
            break
          case 404:
            msg = 'File not found (404). The download URL no longer exists or is incorrect.'
            break
          case 408:
            msg = 'Request timeout (408). The server took too long to respond.'
            break
          case 410:
            msg = 'Resource unavailable (410). The file has been permanently deleted.'
            break
          case 421:
            msg = 'Misdirected request (421). The server cannot respond (SSL certificate issue).'
            break
          case 429:
            msg = 'Too many requests (429). The server limits the number of downloads (rate limit).'
            break
          default:
            msg = `Unhandled client error (${status}).`
        }
        await log.error(msg)
        throw new Error(msg)
      }
    }
    writer.close()
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath)
    }
    throw err
  }
}
