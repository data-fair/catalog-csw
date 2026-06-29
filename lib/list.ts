import type { CatalogPlugin, ListContext } from '@data-fair/types-catalogs'
import type { CSWConfig } from '#types'
import type { CswRecord } from './utils/types.ts'
import { XMLParser } from 'fast-xml-parser'
import axios from '@data-fair/lib-node/axios.js'
import capabilities from './capabilities.ts'
import { asArray, getText } from './utils/common.ts'
import { findDownloadUrls } from './utils/link-selection.ts'

type ResourceList = Awaited<ReturnType<CatalogPlugin['list']>>['results']

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true
})

export const list = async (config: ListContext<CSWConfig, typeof capabilities>): ReturnType<CatalogPlugin<CSWConfig>['list']> => {
  const { catalogConfig, params } = config
  const currentFolderId = params?.currentFolderId || ''

  if (!currentFolderId) {
    const query = params?.q ? params.q.trim() : ''
    const page = Number(params?.page || 1)
    const size = Number(params?.size || 10)
    const startPosition = (page - 1) * size + 1

    const typeFilter = `
      <ogc:PropertyIsEqualTo>
        <ogc:PropertyName>dc:type</ogc:PropertyName>
        <ogc:Literal>dataset</ogc:Literal>
      </ogc:PropertyIsEqualTo>`

    const filterContent = query
      ? `
        <ogc:And>
          ${typeFilter}
          <ogc:PropertyIsLike wildCard="*" singleChar="_" escapeChar="\\\\" matchCase="false">
            <ogc:PropertyName>AnyText</ogc:PropertyName>
            <ogc:Literal>*${query}*</ogc:Literal>
          </ogc:PropertyIsLike>
        </ogc:And>`
      : typeFilter

    const constraintBlock = `
      <csw:Constraint version="1.1.0">
        <ogc:Filter>
          ${filterContent}
        </ogc:Filter>
      </csw:Constraint>`

    const cswBody = `
      <csw:GetRecords 
        xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" 
        xmlns:ogc="http://www.opengis.net/ogc"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        service="CSW" 
        version="2.0.2" 
        resultType="results" 
        startPosition="${startPosition}" 
        maxRecords="${size}" 
        outputSchema="http://www.opengis.net/cat/csw/2.0.2">
        <csw:Query typeNames="csw:Record">
          <csw:ElementSetName>summary</csw:ElementSetName>
          ${constraintBlock}
        </csw:Query>
      </csw:GetRecords>`

    try {
      const response = await axios.post(catalogConfig.url, cswBody, {
        headers: { 'Content-Type': 'application/xml' }
      })

      const parsed = parser.parse(response.data)
      const root = parsed.GetRecordsResponse || parsed['csw:GetRecordsResponse']
      if (!root) return { count: 0, results: [], path: [] }

      const searchResults = root.SearchResults || root['csw:SearchResults']
      if (!searchResults) return { count: 0, results: [], path: [] }

      const totalCount = parseInt(searchResults.numberOfRecordsMatched || searchResults['numberOfRecordsMatched'] || '0', 10)
      const rawRecords = searchResults.SummaryRecord || searchResults.Record || []
      const records = asArray(rawRecords) as CswRecord[]

      const listResults = records.map((record: any) => {
        const identifier = getText(record.identifier || record['dc:identifier'])
        const titleRecord = getText(record.title || record['dc:title']) || 'Sans titre'
        const rawDateObj = record.modified || record.date || record.dateStamp || record.RevisionDate
        const dateRaw = getText(rawDateObj)
        return {
          id: identifier,
          title: titleRecord,
          updatedAt: dateRaw || new Date().toISOString(),
          type: 'folder'
        }
      }) as ResourceList

      return { count: totalCount, results: listResults, path: [] }
    } catch (error: any) {
      console.error('Error retrieving datasets:', error.message)
      return { count: 0, results: [], path: [] }
    }
  }
  const page = Number(params?.page || 1)
  const size = Number(params?.size || 10)

  const actualId = currentFolderId
  const cswBody = `
    <csw:GetRecordById 
      xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" 
      service="CSW" 
      version="2.0.2" 
      outputSchema="http://www.isotc211.org/2005/gmd">
      <csw:Id>${actualId}</csw:Id>
      <csw:ElementSetName>full</csw:ElementSetName>
    </csw:GetRecordById>`

  try {
    const response = await axios.post(catalogConfig.url, cswBody, {
      headers: { 'Content-Type': 'application/xml' }
    })
    const parsed = parser.parse(response.data)
    const root = parsed.GetRecordByIdResponse || parsed['csw:GetRecordByIdResponse']
    const metadata = root?.MD_Metadata || root?.['gmd:MD_Metadata']
    let datasetTitle = 'Jeu de données'
    try {
      const idInfo = asArray(metadata?.identificationInfo || metadata?.['gmd:identificationInfo'] || [])[0]
      const dataId = idInfo?.MD_DataIdentification || idInfo?.['gmd:MD_DataIdentification'] || idInfo?.SV_ServiceIdentification || idInfo?.['srv:SV_ServiceIdentification']
      const citation = dataId?.citation || dataId?.['gmd:citation']
      const ciCitation = citation?.CI_Citation || citation?.['gmd:CI_Citation']
      const titleNode = ciCitation?.title || ciCitation?.['gmd:title']
      datasetTitle = getText(titleNode?.CharacterString || titleNode?.['gco:CharacterString'] || titleNode) || datasetTitle
    } catch (e) {
    }
    const validLinks = await findDownloadUrls(metadata, actualId)

    const resources: ResourceList = validLinks.map(link => {
      const urlBase64 = Buffer.from(link.url).toString('base64')
      const displayFormat = link.format.toUpperCase()
      let titleExtra = ''
      if (displayFormat === 'ZIP') {
        titleExtra = link.name ? ` - ${link.name}` : ''
      }
      return {
        id: `${actualId}|${link.format}|${urlBase64}`,
        title: `${displayFormat}${titleExtra}`,
        format: link.format,
        type: 'resource'
      }
    })
    const startIndex = (page - 1) * size
    const endIndex = startIndex + size
    const paginatedResources = resources.slice(startIndex, endIndex)
    return {
      count: resources.length,
      results: paginatedResources,
      path: [
        { id: currentFolderId, title: `FORMATS DISPONIBLES - ${datasetTitle}`, type: 'folder' }
      ]
    }
  } catch (error: any) {
    console.error('Error checking links:', error.message)
    return { count: 0, results: [], path: [] }
  }
}
