import axios from '@data-fair/lib-node/axios.js'
import { getText, asArray } from './common.ts'
import type { DownloadCandidate } from './types.ts'

export const isUrlValid = async (url: string, isWFSTest = false): Promise<boolean> => {
  try {
    if (isWFSTest) {
      const testUrl = new URL(url)
      testUrl.searchParams.set('COUNT', '1')
      testUrl.searchParams.set('MAXFEATURES', '1')

      const response = await axios.get(testUrl.toString(), {
        timeout: 5000,
        validateStatus: (status) => status < 500
      })

      if (response.status >= 400) {
        return false
      }
      const content = String(response.data)
      if (content.includes('ExceptionReport') || content.includes('ServiceException')) {
        return false
      }
      // if the requested format is JSON but the response is XML, it's likely that the WFS doesn't support the requested format
      const contentType = response.headers['content-type'] || ''
      const requestedFormat = testUrl.searchParams.get('OUTPUTFORMAT') || ''
      if (requestedFormat.includes('json') && contentType.includes('xml')) {
        return false
      }

      return true
    } else {
      await axios.head(url, { timeout: 3000, validateStatus: (s) => s >= 200 && s < 400 })
      return true
    }
  } catch (err) {
    return false
  }
}

const negotiateWfsFormat = async (
  originalUrl: string,
  resourceId: string,
  layerName: string | null | undefined
): Promise<{ url: string; format: string } | null> => {
  const [baseUrl, existingQuery] = originalUrl.split('?')
  const params = new URLSearchParams(existingQuery || '')

  const keysToDelete: string[] = []
  for (const key of params.keys()) {
    const lowerKey = key.toLowerCase()
    if (['service', 'request', 'version', 'typename', 'typenames', 'outputformat', 'srsname'].includes(lowerKey)) {
      keysToDelete.push(key)
    }
  }
  keysToDelete.forEach(k => params.delete(k))

  params.set('SERVICE', 'WFS')
  params.set('VERSION', '2.0.0')
  params.set('REQUEST', 'GetFeature')
  params.set('TYPENAMES', layerName || resourceId)

  const formatsToTry = [
    { param: 'application/json; subtype=geojson', format: 'geojson' },
    { param: 'geojson', format: 'geojson' },
    { param: 'application/json', format: 'geojson' },
    { param: 'application/vnd.geo+json', format: 'geojson' },
    { param: 'json', format: 'geojson' },
    { param: 'SHAPE-ZIP', format: 'zip' },
    { param: 'shapezip', format: 'zip' },
    { param: 'application/x-shapefile', format: 'zip' },
    { param: 'csv', format: 'csv' },
    { param: 'text/csv', format: 'csv' },
    { param: 'application/vnd.google-earth.kml+xml', format: 'kml' }
  ]

  for (const f of formatsToTry) {
    const testParams = new URLSearchParams(params)
    testParams.set('OUTPUTFORMAT', f.param)
    const testUrl = `${baseUrl}?${testParams.toString()}`
    if (await isUrlValid(testUrl, true)) {
      return {
        url: testUrl,
        format: f.format
      }
    }
  }
  return null
}

const detectFormatFromHeaders = async (url: string): Promise<string | null> => {
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      validateStatus: (status) => status < 400
    })
    const contentType = response.headers['content-type']
    if (!contentType) return null

    if (contentType.includes('application/json') || contentType.includes('application/geo+json')) {
      return 'geojson'
    }
    if (contentType.includes('application/zip') || contentType.includes('application/x-zip-compressed')) {
      return 'zip'
    }
    if (contentType.includes('text/csv') || contentType.includes('application/csv')) {
      return 'csv'
    }
    if (contentType.includes('text/tab-separated-values') || contentType.includes('text/tsv')) {
      return 'tsv'
    }
    if (contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
      return 'xlsx'
    }

    if (contentType.includes('application/vnd.ms-excel')) {
      return 'xls'
    }

    if (contentType.includes('application/vnd.oasis.opendocument.spreadsheet')) {
      return 'ods'
    }

    if (contentType.includes('application/gpx+xml') || contentType.includes('gpx')) {
      return 'gpx'
    }

    if (contentType.includes('application/vnd.google-earth.kmz') || contentType.includes('kmz')) {
      return 'kmz'
    }
    return null
  } catch (error) {
    return null
  }
}

const analyzeLink = (linkWrapper: any): DownloadCandidate | null => {
  const link = linkWrapper.CI_OnlineResource || linkWrapper
  const url = getText(link.linkage?.URL)
  const protocol = getText(link.protocol).toLowerCase()
  const name = getText(link.name) || getText(link.description)
  const layer = getText(link.name)

  if (!url) return null

  const u = url.toLowerCase()
  const p = protocol
  const n = name.toLowerCase()
  const base = { url, name }

  if (u.includes('service=wfs') && u.includes('outputformat=')) {
    let format = 'wfs_service'
    const score = 50
    if (u.includes('geojson') || u.includes('json')) format = 'geojson'
    else if (u.includes('csv')) format = 'csv'
    else if (u.includes('zip') || u.includes('shape')) format = 'zip'
    else format = 'unknown'
    return { ...base, format, score }
  }

  if (u.includes('/api/data/') || u.includes('/api/records/')) {
    return { ...base, format: 'unknown', score: 11 }
  }

  if (u.includes('shape-zip') || n.includes('shapefile') || u.endsWith('.zip')) {
    return { ...base, format: 'zip', score: 8 }
  }

  if (u.includes('geojson') || p.includes('geo+json') || n.includes('geojson')) {
    return { ...base, format: 'geojson', score: 10 }
  }

  if (u.includes('/csv') || u.includes('.csv') || p.includes('text/csv') || n === 'csv') {
    return { ...base, format: 'csv', score: 6 }
  }

  if (u.endsWith('.kml') || p.includes('kml')) {
    return { ...base, format: 'kml', score: 4 }
  }

  if ((u.includes('/json') || u.includes('.json') || p.includes('application/json') || n === 'json') && !u.includes('geojson')) {
    return { ...base, format: 'json', score: 5 }
  }

  if (p.includes('ogc:wfs') || p.includes('wfs') || u.includes('service=wfs')) {
    return { ...base, format: 'wfs_service', score: 2, layerName: layer }
  }

  return { ...base, format: 'unknown', score: 1 }
}

export const findDownloadUrls = async (metadata: any, resourceId: string): Promise<{ url: string, format: string, name?: string }[]> => {
  const root = metadata.MD_Metadata || metadata
  const distributionInfo = root?.distributionInfo?.MD_Distribution
  if (!distributionInfo) return []

  const transferOptions = asArray(distributionInfo.transferOptions)

  const allLinks: any[] = []
  for (const transfer of transferOptions) {
    const digitalTransfer = transfer.MD_DigitalTransferOptions || transfer
    if (digitalTransfer && digitalTransfer.onLine) {
      allLinks.push(...asArray(digitalTransfer.onLine))
    }
  }

  if (allLinks.length === 0) return []

  const candidates: DownloadCandidate[] = []
  for (const link of allLinks) {
    const candidate = analyzeLink(link)
    if (candidate) candidates.push(candidate)
  }

  // On garde le tri par score pour afficher les meilleurs formats en premier
  candidates.sort((a, b) => b.score - a.score)

  if (candidates.length === 0) return []

  const validDownloads: { url: string, format: string, name?: string }[] = []

  for (const candidate of candidates) {
    let { url, format, name } = candidate
    if (validDownloads.some(v => v.url === url)) {
      continue
    }

    if (format === 'wfs_service') {
      const wfsResult = await negotiateWfsFormat(url, resourceId, candidate.layerName)
      if (wfsResult) {
        url = wfsResult.url
        format = wfsResult.format
        if (!validDownloads.some(v => v.url === url)) {
          validDownloads.push({ url, format, name })
        }
      }
    } else {
      if (await isUrlValid(url)) {
        if (url.includes('/api/data/')) {
          const urlObj = new URL(url)
          urlObj.searchParams.delete('format')
          const cleanUrl = urlObj.toString()
          const detectedFormat = await detectFormatFromHeaders(cleanUrl)
          if (detectedFormat) {
            url = cleanUrl
            format = detectedFormat
          } else {
            continue
          }
        } else if (format === 'unknown') {
          const detectedFormat = await detectFormatFromHeaders(url)
          if (detectedFormat) {
            format = detectedFormat
          } else {
            continue
          }
        }

        if (!validDownloads.some(v => v.url === url)) {
          validDownloads.push({ url, format, name })
        }
      }
    }
  }

  return validDownloads
}
