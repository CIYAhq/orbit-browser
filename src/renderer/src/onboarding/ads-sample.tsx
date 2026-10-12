/** What Orbit's sample page has (OB-06): the ads it shows, and the trackers that see the visit. */
export const SAMPLE_PAGE = { ads: 3, trackers: 4 }

/** An ad on the sample page: it folds away while blocking is on. */
function SampleAd({ kind, label }: { kind: 'banner' | 'inline' | 'side'; label: string }) {
  return (
    <div className={`ob-ad ob-ad--${kind}`} data-testid="onboarding-ads-ad">
      <div className="ob-ad__fold">
        <div className="ob-ad__box">
          <span className="ob-ad__tag">{label}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Orbit's own sample page for the ads step (OB-06): an article with a banner, an ad in its text and
 * one beside it. With blocking on, the ads fold away and the line under the page counts what was
 * stopped; with it off, they are back.
 */
export function AdsSample({ blocking }: { blocking: boolean }) {
  return (
    <figure
      className={`ob-ads-sample${blocking ? ' is-blocking' : ''}`}
      data-testid="onboarding-ads-sample"
      data-blocking={blocking ? 'true' : 'false'}
    >
      <div className="ob-ads-sample__page" aria-hidden="true">
        <div className="ob-ads-sample__address">news.example</div>
        <SampleAd kind="banner" label="Ad" />
        <div className="ob-ads-sample__body">
          <div className="ob-ads-sample__text">
            <span className="ob-ads-sample__headline" />
            <span />
            <span />
            <span className="is-short" />
            <SampleAd kind="inline" label="Sponsored" />
            <span />
            <span className="is-short" />
          </div>
          <SampleAd kind="side" label="Ad" />
        </div>
      </div>
      <figcaption className="ob-ads-sample__count" data-testid="onboarding-ads-count" aria-live="polite">
        {blocking
          ? `${SAMPLE_PAGE.ads} ads and ${SAMPLE_PAGE.trackers} trackers stopped on this page`
          : `${SAMPLE_PAGE.ads} ads shown, and ${SAMPLE_PAGE.trackers} trackers see this visit`}
      </figcaption>
    </figure>
  )
}
