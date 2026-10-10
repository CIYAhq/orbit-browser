import { useEffect } from 'react'
import { useDark } from '../theme'
import { INDEX_NAME, INTERNAL_PAGES, type InternalPage, internalUrl } from './registry'
import './internal.css'

/** `orbit://pages/`: every internal page, with a line on each. */
function PageIndex() {
  return (
    <>
      <h1 className="internal__title">Internal pages</h1>
      <ul className="internal__list">
        {INTERNAL_PAGES.filter((p) => !p.hidden).map((p) => (
          <li key={p.name} className="internal__item">
            <a className="internal__link" data-testid="internal-page-link" href={internalUrl(p.name)}>
              {internalUrl(p.name)}
            </a>
            <span className="internal__item-title">{p.title}</span>
            <span className="internal__item-text">{p.description}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

const INDEX: InternalPage = {
  name: INDEX_NAME,
  title: 'Internal pages',
  description: 'This list.',
  component: PageIndex,
}

function NotFound({ name }: { name: string }) {
  return (
    <>
      <h1 className="internal__title">No such page</h1>
      <p className="internal__text">
        Orbit has no internal page at <code>{internalUrl(name)}</code>.{' '}
        <a className="internal__link" href={internalUrl(INDEX_NAME)}>
          See them all
        </a>
      </p>
    </>
  )
}

/** An internal page (DT-13): the one the address names, in the app's light or dark look. */
export function InternalApp() {
  const name = location.hostname.toLowerCase()
  const page = name === INDEX_NAME ? INDEX : INTERNAL_PAGES.find((p) => p.name === name)
  const dark = useDark()
  useEffect(() => {
    document.title = page?.title ?? 'No such page'
  }, [page])
  useEffect(() => {
    document.documentElement.dataset.dark = dark ? 'true' : 'false'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  const Page = page?.component
  return (
    <main
      className="internal"
      data-testid="internal-page"
      data-page={page?.name ?? ''}
      data-dark={dark ? 'true' : 'false'}
    >
      <div className="internal__body">{Page ? <Page /> : <NotFound name={name} />}</div>
    </main>
  )
}
