import { XMLParser } from 'fast-xml-parser'
import path from 'path'
import axios from '@data-fair/lib-node/axios.js'
import type { CatalogPlugin, GetResourceContext, Resource } from '@data-fair/types-catalogs'
import type { CSWConfig } from '#types'
import { downloadFileWithProgress } from './utils/download.ts'
import { getText } from './utils/common.ts'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: true
})

export const getResource = async ({ resourceId, tmpDir, log, catalogConfig }: GetResourceContext<CSWConfig>): ReturnType<CatalogPlugin['getResource']> => {
  const parts = resourceId.split('|')
  if (parts.length !== 3) {
    throw new Error('Identifiant de ressource invalide.')
  }

  const [actualId, formatUrl, urlBase64] = parts
  const url = Buffer.from(urlBase64, 'base64').toString('utf-8')

  await log.step('Récupération des métadonnées (description et titre)')
  const cswBody = `
    <csw:GetRecordById 
      xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" 
      service="CSW" 
      version="2.0.2" 
      outputSchema="http://www.isotc211.org/2005/gmd">
      <csw:Id>${actualId}</csw:Id>
      <csw:ElementSetName>summary</csw:ElementSetName>
    </csw:GetRecordById>`

  let datasetTitle = actualId
  let descriptionDataset = ''

  try {
    const response = await axios.post(catalogConfig.url, cswBody, {
      headers: { 'Content-Type': 'application/xml' }
    })
    const parsed = parser.parse(response.data)
    const root = parsed.GetRecordByIdResponse || parsed['csw:GetRecordByIdResponse']
    const metadata = root?.MD_Metadata || root?.['gmd:MD_Metadata']
    const dataId = metadata?.identificationInfo?.MD_DataIdentification || {}
    const titleObj = dataId?.citation?.CI_Citation?.title
    datasetTitle = getText(titleObj) || actualId
    const abstractObj = dataId?.abstract
    descriptionDataset = getText(abstractObj) || ''
  } catch (error) {
    await log.warning(`Impossible de récupérer les métadonnées pour ${actualId}`)
  }

  await log.step('Downloading file')
  const datasetTitleSafe = datasetTitle
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()

  const fileName = `${datasetTitleSafe}.${formatUrl}`
  const destPath = path.join(tmpDir, fileName)

  await downloadFileWithProgress(url, destPath, datasetTitleSafe, log)

  return {
    id: resourceId,
    title: `${datasetTitle} (${formatUrl})`,
    description: descriptionDataset,
    filePath: destPath,
    format: formatUrl,
    updatedAt: new Date().toISOString(),
    size: 0
  } as Resource
}
