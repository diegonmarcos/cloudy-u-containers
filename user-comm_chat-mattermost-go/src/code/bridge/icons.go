package bridge

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// glyphs is a 5x7 bitmap font for the letters the profile icons use.
var glyphs = map[rune][7]string{
	'C': {".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."},
	'3': {"####.", "....#", "....#", ".###.", "....#", "....#", "####."},
	'H': {"#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"},
	'O': {".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."},
	'S': {".####", "#....", "#....", ".###.", "....#", "....#", "####."},
}

func parseHexColor(c string) color.RGBA {
	c = strings.TrimPrefix(c, "#")
	v, _ := strconv.ParseUint(c, 16, 32)
	return color.RGBA{R: uint8(v >> 16), G: uint8(v >> 8), B: uint8(v), A: 255}
}

// MakeColoredPNG renders a size x size PNG in the given colour with the letters centred in white. Pillow's default
// font cannot be reproduced bit for bit without a font file, so this uses a built-in bitmap font; dimensions, colour
// and the white letter on a solid background match the Python icons.
func MakeColoredPNG(letters, hexColor string, size int) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	bg := parseHexColor(hexColor)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			img.SetRGBA(x, y, bg)
		}
	}
	rs := []rune(letters)
	scale := 8
	if len(rs) > 1 {
		scale = 7
	}
	w := (len(rs)*5 + (len(rs) - 1)) * scale
	h := 7 * scale
	x0, y0 := (size-w)/2, (size-h)/2
	white := color.RGBA{255, 255, 255, 255}
	for i, r := range rs {
		gl, ok := glyphs[r]
		if !ok {
			continue
		}
		for gy, row := range gl {
			for gx, ch := range row {
				if ch != '#' {
					continue
				}
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						img.SetRGBA(x0+(i*6+gx)*scale+dx, y0+gy*scale+dy, white)
					}
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// IconSpec is one account icon.
type IconSpec struct{ Username, Color, Letter string }

// Icons is the fixed icon set, in the Python dict order.
var Icons = []IconSpec{
	{"c3-bot", "#00B8D9", "C3"}, {HAIUsername, "#00BCD4", "H"},
	{"claude-opus-ai", "#FF6B35", "O"}, {"claude-sonnet-ai", "#7B61FF", "S"}, {"claude-haiku-ai", "#00C853", "H"},
}

// SetAccountIcons uploads the profile icons of the known accounts (POST /users/{id}/image, multipart "image").
func (b *Bridge) SetAccountIcons(h Headers, accountIDs map[string]string) error {
	for _, ic := range Icons {
		uid := accountIDs[ic.Username]
		if uid == "" {
			continue
		}
		data, err := MakeColoredPNG(ic.Letter, ic.Color, 128)
		if err != nil {
			return err
		}
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		hdr := textproto.MIMEHeader{}
		hdr.Set("Content-Disposition", `form-data; name="image"; filename="icon.png"`)
		hdr.Set("Content-Type", "image/png")
		part, err := mw.CreatePart(hdr)
		if err != nil {
			return err
		}
		_, _ = part.Write(data)
		_ = mw.Close()
		hh := Headers{"Content-Type": mw.FormDataContentType()}
		for k, v := range h {
			hh[k] = v
		}
		r, err := b.doRaw("POST", b.Cfg.MMURL+"/api/v4/users/"+uid+"/image", hh, body.Bytes(), 30*time.Second)
		if err != nil {
			return err
		}
		if r.OK() {
			b.logf("Set icon for %s", ic.Username)
		} else {
			b.logf("Failed to set icon for %s: %s", ic.Username, trunc(r.Text(), 100))
		}
	}
	return nil
}

var _ = fmt.Sprint
