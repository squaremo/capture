const LINEAR_API_URL = 'https://api.linear.app/graphql'

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($teamId: String!, $title: String!, $description: String) {
    issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
      success
      issue { url title }
    }
  }
`

const SEARCH_ISSUES_QUERY = `
  query SearchIssues($teamId: String!, $query: String!) {
    issues(filter: { team: { id: { eq: $teamId } }, title: { containsIgnoreCase: $query } }, first: 1) {
      nodes { title url }
    }
  }
`

async function linearRequest({ apiKey, query, variables }) {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    // Linear personal API keys go in Authorization as-is, no "Bearer" prefix.
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) throw new Error(`Linear API error: ${res.status}`)

  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(`Linear API error: ${errors[0].message}`)
  return data
}

export async function createLinearTask({ apiKey, teamId, title, description }) {
  const data = await linearRequest({ apiKey, query: CREATE_ISSUE_MUTATION, variables: { teamId, title, description } })
  if (!data.issueCreate.success) throw new Error('Linear issue creation failed')
  return data.issueCreate.issue
}

// Read-only: looks for an existing issue with a similar title, so a plan can
// branch on whether this capture would duplicate tracked work.
export async function searchLinearIssues({ apiKey, teamId, query }) {
  const data = await linearRequest({ apiKey, query: SEARCH_ISSUES_QUERY, variables: { teamId, query } })
  const matchingIssue = data.issues.nodes[0] ?? null
  return { duplicate_found: Boolean(matchingIssue), matching_issue: matchingIssue }
}
