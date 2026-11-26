"""Static checks (no browser needed)."""

from framesheet.checks import check_html_source, check_svg_source
from tests.conftest import FIXTURES


def codes(findings) -> set[str]:
    return {f.code for f in findings}


SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>t</title>{}</svg>'


def test_clean_fixture_passes():
    assert check_svg_source((FIXTURES / "pipeline.svg").read_text()) == []


def test_malformed_xml():
    assert codes(check_svg_source("<svg><g></svg>")) == {"malformed-xml"}


def test_root_namespace_viewbox_and_title():
    found = codes(check_svg_source("<svg/>"))
    assert {"missing-xmlns", "missing-viewbox", "missing-title"} <= found


def test_script_handlers_and_external_urls():
    found = codes(
        check_svg_source(
            SVG.format(
                '<script>1</script><rect onclick="x()"/><image href="https://example.com/a.png"/>'
                "<foreignObject/>"
            )
        )
    )
    assert {"script", "event-handler", "external-url", "foreign-object"} <= found


def test_duplicate_and_broken_ids():
    found = check_svg_source(
        SVG.format('<g id="a"/><g id="a"/><use href="#missing"/><rect fill="url(#nope)"/>')
    )
    assert codes(found) == {"duplicate-id", "broken-ref"}
    assert sum(f.code == "broken-ref" for f in found) == 2


def test_positive_begin_on_animate_motion():
    assert "positive-begin" in codes(check_svg_source(SVG.format('<animateMotion begin="1s"/>')))
    assert "positive-begin" not in codes(
        check_svg_source(SVG.format('<animateMotion begin="-0.5s"/>'))
    )


def test_css_checks():
    css = "<style>@keyframes s { to { transform: rotate(1turn) } } .a { animation: s 1s }</style>"
    found = codes(check_svg_source(SVG.format(css)))
    assert {"no-reduced-motion", "transform-without-box"} <= found
    origin = "<style>.a { transform: rotate(4deg); transform-origin: center }</style>"
    assert "transform-origin-without-box" in codes(check_svg_source(SVG.format(origin)))


def test_css_comments_are_ignored():
    css = (
        "<style>/* transform-box: fill-box */ @keyframes s { to { transform: scale(2) } }"
        " .a { animation: s 1s } @media (prefers-reduced-motion: reduce) {}</style>"
    )
    assert "transform-without-box" in codes(check_svg_source(SVG.format(css)))


def test_large_file():
    assert "large-file" in codes(check_svg_source(SVG.format("<!--" + "x" * 120_000 + "-->")))


def test_html_checks():
    html = (
        '<html><body><div id="a"></div><p id="a"></p><a href="#top">top</a>'
        '<svg><use href="#gone"/></svg><style>.x { animation: y 1s }</style></body></html>'
    )
    found = codes(check_html_source(html))
    assert found == {"duplicate-id", "broken-ref", "no-reduced-motion"}
